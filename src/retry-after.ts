/**
 * Parsing for the HTTP `Retry-After` header.
 *
 * Adapted from Yuuqq/jules-dispatch (MIT), `parseRetryAfterMs` in
 * src/client.ts, which documents the trap this exists to avoid.
 *
 * The rule underneath it is the fleet's "a falsy-empty result must not choose a
 * default branch": an absent or blank `Retry-After` is the POSITIVE fact that
 * the server gave no advice, not a value of zero. Collapsing the two turns a
 * rate-limit response into a hot loop against the thing that just rate-limited
 * you — the worst available reading of the header.
 *
 * Our previous expression was `retryAfter ? parseInt(retryAfter, 10) : undefined`,
 * which differs from theirs in its failure mode rather than in being correct:
 * `parseInt('', 10)` is `NaN`, not 0. `NaN` is falsy in the message template so
 * it looked harmless, but it survives arithmetic (`NaN * 1000` is `NaN`) and
 * `setTimeout(fn, NaN)` fires immediately — so it becomes the same hot loop the
 * moment anything actually sleeps on the value.
 */

/**
 * Parse `Retry-After` into a non-negative whole number of seconds.
 *
 * Both legal forms of the header are handled:
 *   - delta-seconds  (`"120"`)
 *   - HTTP-date      (`"Wed, 21 Oct 2026 07:28:00 GMT"`), resolved against `now`
 *
 * Returns `undefined` — never `NaN`, never `0` — when the header is absent,
 * blank, whitespace-only, or unparseable, so callers can distinguish "wait this
 * long" from "no advice, use your own backoff". A literal `"0"` is a legitimate
 * value and is preserved as `0`; do not "fix" this by rejecting falsy results.
 *
 * A date already in the past clamps to `0` rather than going negative, matching
 * the delta-seconds clamp.
 */
export function parseRetryAfterSeconds(
    header: string | null | undefined,
    now: number = Date.now(),
): number | undefined {
    if (header === null || header === undefined) return undefined;

    const trimmed = header.trim();
    if (trimmed === '') return undefined;

    // delta-seconds. Anchored and digits-only on purpose: parseInt('12abc', 10)
    // is 12, which would silently accept a malformed header as advice.
    if (/^[+-]?\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        if (!Number.isFinite(seconds)) return undefined;
        return Math.max(Math.trunc(seconds), 0);
    }

    // HTTP-date.
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    return Math.max(Math.ceil((at - now) / 1000), 0);
}

/**
 * Milliseconds to wait before retrying, or `undefined` when the header gave no
 * usable advice and the caller should fall back to its normal backoff.
 *
 * Kept separate from the seconds form because the seconds value is what the
 * user-facing error message quotes, while this is what a sleep consumes — and
 * the failure this file exists to prevent is precisely a bad value reaching the
 * sleep.
 */
export function parseRetryAfterMs(
    header: string | null | undefined,
    now: number = Date.now(),
): number | undefined {
    const seconds = parseRetryAfterSeconds(header, now);
    return seconds === undefined ? undefined : seconds * 1000;
}
