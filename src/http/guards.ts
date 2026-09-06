/**
 * Request guards for the streamable-HTTP transport (Redmine #50638).
 *
 * Everything in this module is a pure function of the request HEADERS. That is
 * deliberate and it is the whole point of the file.
 *
 * The journal note on #50638 revised the ticket's own acceptance criteria
 * after #50662: on this fleet a loopback bind does not mean "reachable only
 * from this host". `socat-relay@stargazer.service` listens on a tailnet address
 * and forwards to 127.0.0.1, and socat RE-ORIGINATES the connection, so the
 * backend observes 127.0.0.1 as the peer for every relayed request. Any check
 * shaped like "is the caller local?" therefore answers yes for the entire
 * tailnet. Relays are normal here, not exotic.
 *
 * Two rules follow, and both are asserted in tests/http/guards.test.ts:
 *
 *   1. Authentication is UNCONDITIONAL. It is not gated on the bind address,
 *      the peer address, or anything else about where the packet came from.
 *   2. A proxy-supplied identity is honoured ONLY when the request also
 *      carries a shared secret matching a server-side value, compared in
 *      constant time. With no secret configured the proxy path is disabled
 *      outright rather than trusting the header — a secure default. This is
 *      the in-fleet pattern from #2176, ported rather than redesigned.
 *
 * The negative knowledge this is defending against is concrete:
 *   - #50652 (cavuminfundo/jules-mcp-server): 0.0.0.0 listener, no auth, no
 *     Origin validation, dispatch through `globals()`.
 *   - #50775 (Scarmonit/antigravity-jules-orchestration): a publicly-deployed
 *     unauthenticated POST /mcp/execute forwarding request bodies straight to
 *     Jules with the deployer's own API key.
 * We hold a JULES_API_KEY with write access to hundreds of connected sources.
 * An HTTP surface in front of tool dispatch inherits that key's full
 * authority, so the surface has to authenticate before it dispatches.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** The subset of `IncomingHttpHeaders` these guards read. */
export type HeaderBag = Record<string, string | string[] | undefined>;

export interface AuthConfig {
    /** Shared bearer token. Empty means "deny everything". */
    token: string;
    /** Optional secret a fronting proxy must present to assert an identity. */
    proxySecret?: string;
}

export type AuthOutcome =
    | { ok: true; principal: string; via: 'bearer' | 'proxy' }
    | { ok: false; status: 401; message: string };

export type OriginOutcome =
    { ok: true; echo?: string } | { ok: false; status: 403; message: string };

/** Proxy identities we are willing to put in a log line, and nothing else. */
const IDENTITY_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

const DENY: AuthOutcome = {
    ok: false,
    status: 401,
    message: 'Unauthorized',
};

/**
 * Constant-time string comparison.
 *
 * Digests both sides first. `timingSafeEqual` throws when the two buffers have
 * different lengths, and guarding that with a length check leaks the expected
 * length; hashing to a fixed 32 bytes removes both problems. An empty string
 * on either side is always false, so an unset secret can never match an unset
 * header.
 */
export function constantTimeEquals(a: string, b: string): boolean {
    if (a.length === 0 || b.length === 0) return false;
    const da = createHash('sha256').update(a, 'utf8').digest();
    const db = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(da, db);
}

/**
 * Read a single-valued header. A repeated header arrives from Node as an
 * array; two candidate credentials in one request is a smuggling shape rather
 * than a login, so it is treated as absent.
 */
function single(headers: HeaderBag, name: string): string | undefined {
    const value = headers[name];
    return typeof value === 'string' ? value : undefined;
}

/**
 * Decide whether a request is authenticated, from headers alone.
 *
 * Order matters: a request that presents the proxy secret header is judged on
 * that header and NOT allowed to fall through to the bearer path, so a
 * mismatching proxy secret is a hard denial rather than a retry.
 */
export function authenticateRequest(
    headers: HeaderBag,
    config: AuthConfig,
): AuthOutcome {
    const suppliedProxySecret = single(headers, 'x-forwarded-auth-secret');

    // The proxy path exists only when a secret is configured. With no secret,
    // x-forwarded-* is inert data: not trusted, not consulted, not a fallback.
    if (config.proxySecret && suppliedProxySecret !== undefined) {
        if (!constantTimeEquals(suppliedProxySecret, config.proxySecret)) {
            return DENY;
        }
        const identity = single(headers, 'x-forwarded-user');
        if (identity === undefined) {
            return { ok: true, principal: 'proxy:unknown', via: 'proxy' };
        }
        if (!IDENTITY_PATTERN.test(identity)) {
            return DENY;
        }
        return { ok: true, principal: `proxy:${identity}`, via: 'proxy' };
    }

    const authorization = single(headers, 'authorization');
    if (authorization === undefined) return DENY;

    // Split on the first space only: the scheme is case-insensitive per
    // RFC 7235, the credential is not.
    const spaceAt = authorization.indexOf(' ');
    if (spaceAt === -1) return DENY;
    const scheme = authorization.slice(0, spaceAt);
    const credential = authorization.slice(spaceAt + 1);
    if (scheme.toLowerCase() !== 'bearer') return DENY;
    if (!constantTimeEquals(credential, config.token)) return DENY;

    return { ok: true, principal: 'bearer', via: 'bearer' };
}

/**
 * Validate the `Origin` header.
 *
 * The MCP spec requires Origin validation on Streamable HTTP servers to defeat
 * DNS rebinding. An absent Origin is allowed because non-browser clients do
 * not send one and it is browsers this control is aimed at; the unconditional
 * bearer check above is what stops a non-browser caller.
 *
 * The allowlist is exact-match. There is no wildcard, no suffix matching and
 * no case folding: `Access-Control-Allow-Origin: *` on an endpoint holding a
 * Jules API key is precisely the defect recorded against the reference
 * implementation in #50638.
 */
export function validateOrigin(
    origin: string | string[] | undefined,
    allowedOrigins: readonly string[],
): OriginOutcome {
    if (origin === undefined) return { ok: true };
    if (typeof origin !== 'string') {
        return { ok: false, status: 403, message: 'Invalid Origin header' };
    }
    if (allowedOrigins.includes(origin) && origin !== '*') {
        return { ok: true, echo: origin };
    }
    return { ok: false, status: 403, message: 'Origin not allowed' };
}
