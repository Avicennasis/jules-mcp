/**
 * Guards for auto-paginating walks over the Jules API.
 *
 * Both guards exist because a paginating loop is the shape that fails
 * *unboundedly* rather than loudly: when the terminating condition can never
 * become true, "not finished yet" and "will never finish" render identically,
 * and the loop just keeps going. The fleet has a recorded case of a poll loop
 * spinning 9h26m unnoticed for exactly that reason.
 *
 * Adapted from Yuuqq/jules-dispatch (MIT), `guardPageToken` in src/client.ts.
 */

/** Wall-clock ceiling for a single paginated walk. */
export const PAGINATION_DEADLINE_MS = 60_000;

export class PaginationLoopError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PaginationLoopError';
    }
}

/**
 * Record a `nextPageToken` and throw if it has been seen before.
 *
 * A repeated token is never a legitimate server state — it is a server bug or
 * a client bug — so failing loudly beats silently collecting duplicate rows and
 * then reporting a truncated scan. That matters here because callers reason
 * about scan *completeness* (`suggestions_only` decides "no matches exist" from
 * a walk), and duplicate rows make every count and every SCAN INCOMPLETE
 * judgement wrong rather than merely imprecise.
 *
 * The empty string is deliberately not tracked: `''` is falsy and already
 * terminates every caller's `while (token)`, so it can never drive a loop, and
 * recording it would make two independent "no more pages" replies look like a
 * repeat. Callers must therefore keep testing the token for truthiness — this
 * guard bounds a loop, it does not decide when one ends.
 */
export function guardPageToken(
    token: string | undefined,
    seen: Set<string>,
    resource: string,
): void {
    if (!token) return;
    if (seen.has(token)) {
        throw new PaginationLoopError(
            `Jules API repeated page token while listing ${resource}: ${token}`,
        );
    }
    seen.add(token);
}

/**
 * Throw once a paginated walk has run past its wall-clock deadline.
 *
 * The repeated-token guard alone is not sufficient: a server that *cycles*
 * between two or more tokens rather than repeating one defeats a seen-set on
 * the first lap but not on the second — and a server that mints a fresh token
 * every time defeats it entirely. The page cap bounds those, and this bounds
 * the case where each individual request is merely slow. Three independent
 * terminations, so no single unforeseen failure mode leaves the loop unbounded.
 */
export function guardPaginationDeadline(
    startedAt: number,
    resource: string,
    deadlineMs: number = PAGINATION_DEADLINE_MS,
    now: number = Date.now(),
): void {
    const elapsed = now - startedAt;
    if (elapsed > deadlineMs) {
        throw new PaginationLoopError(
            `Jules API pagination exceeded ${deadlineMs}ms while listing ${resource} ` +
                `(elapsed ${elapsed}ms) — aborting rather than continuing an unbounded walk.`,
        );
    }
}
