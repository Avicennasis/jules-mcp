/**
 * Outbound HTTP transport.
 *
 * Node's global `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`, so
 * behind a corporate proxy every request to the Jules API and to GitHub fails
 * outright -- the server is unusable there, not merely degraded (#50424).
 *
 * When a proxy is configured we route through undici's `EnvHttpProxyAgent`,
 * which reads those env vars itself (including `NO_PROXY`). Two details are
 * load-bearing:
 *
 *  1. undici's OWN `fetch`, not the global one. The two implementations do not
 *     share a dispatcher type, and handing an undici dispatcher to the global
 *     fetch silently drops response headers -- `content-encoding` and
 *     `retry-after` among them. `retry-after` feeds the 429 backoff in
 *     src/retry-after.ts, so losing it is a behavioural regression, not a
 *     cosmetic one.
 *
 *  2. Resolution is LAZY and cached against the proxy env value. Choosing the
 *     transport at import time ignores env set afterwards (the bug this
 *     avoids); resolving it on every request would pay the undici import on the
 *     hot path. With no proxy configured this returns the global fetch and
 *     never imports undici at all.
 */

type FetchLike = typeof fetch;

let cachedKey: string | undefined;
let cachedFetch: FetchLike | undefined;

/** Separator that cannot occur in a URL, so the key is unambiguous. */
const SEP = '\u0000';

/** The proxy env that decides the transport, as undici reads it. */
function proxyEnvKey(): string {
    return [
        process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '',
        process.env.HTTP_PROXY ?? process.env.http_proxy ?? '',
        process.env.NO_PROXY ?? process.env.no_proxy ?? '',
    ].join(SEP);
}

function proxyConfigured(key: string): boolean {
    const [https, http] = key.split(SEP);
    return https !== '' || http !== '';
}

/**
 * The fetch to use for outbound requests. Cached per proxy env, so a process
 * that never sets a proxy pays nothing and never loads undici.
 */
export async function resolveFetch(): Promise<FetchLike> {
    const key = proxyEnvKey();
    if (cachedFetch && cachedKey === key) return cachedFetch;

    if (!proxyConfigured(key)) {
        // Return the LIVE global fetch, uncached. Caching the reference would
        // pin whatever globalThis.fetch was at the first call, so a later
        // replacement -- a test stub, or instrumentation -- would be ignored.
        // Re-reading six env vars per request costs nothing.
        cachedKey = undefined;
        cachedFetch = undefined;
        return fetch;
    }

    const { fetch: undiciFetch, EnvHttpProxyAgent } = await import('undici');
    const dispatcher = new EnvHttpProxyAgent();
    // undici's fetch has its own RequestInit/Response types; the cast is at the
    // boundary so the rest of the codebase keeps using the standard fetch types.
    const proxied = ((input: unknown, init?: unknown) =>
        undiciFetch(
            input as Parameters<typeof undiciFetch>[0],
            {
                ...(init as Record<string, unknown>),
                dispatcher,
            } as Parameters<typeof undiciFetch>[1],
        )) as unknown as FetchLike;

    cachedKey = key;
    cachedFetch = proxied;
    return cachedFetch;
}

/** Test seam: forget the cached transport so env changes are re-read. */
export function resetFetchTransport(): void {
    cachedKey = undefined;
    cachedFetch = undefined;
}
