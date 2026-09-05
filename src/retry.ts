/**
 * Retry policy for Jules API requests.
 *
 * Adapted from Yuuqq/jules-dispatch (MIT), `src/client.ts:37-101` — the
 * sharpest retry implementation found across the 26 community Jules projects
 * surveyed. Redmine #50643, consolidating #50416, #50447, #50451 and #50461.
 *
 * The distinction that makes it worth copying:
 *
 *   A 429 means the request was REJECTED WITHOUT BEING PROCESSED. Replaying it
 *   is safe for any method, POST included.
 *
 *   A 5xx or a dropped socket is AMBIGUOUS. The server may have created the
 *   session and failed on the way back, so replaying a POST can double-create.
 *   Jules has no idempotency key and no measured daily quota ceiling (#50428),
 *   which makes a duplicate session a real cost, not a tidiness problem.
 *
 * So: 429 retries for every method; 5xx and network errors retry only for
 * idempotent ones. This is the nuance #50416 flagged as the hazard, and it is
 * the bug in georgeracu/google-jules-mcp-server, which retries POST /sessions
 * on 5xx unguarded.
 *
 * Two additions beyond the reference:
 *
 *   - A timeout is never retried. It is our own deadline expiring, not the
 *     server asking us to wait, and retrying multiplies a wall-clock the caller
 *     already bounded.
 *   - A wait longer than `maxDelayMs` is declined rather than slept through.
 *     The reference sleeps for whatever `Retry-After` says; inside an MCP tool
 *     call an hour-long sleep is worse than an error, because the caller gets
 *     no answer and no chance to decide. The exponential term is CLAMPED to the
 *     cap instead of declined — that delay is ours, not the server's advice.
 */

/** Defaults; every one is overridable per call so tests need no fake timers. */
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_JITTER_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * Whether replaying `method` is safe when the outcome of the first attempt is
 * unknown. PATCH is deliberately absent: it is idempotent only if the patch
 * itself is, which we cannot know from here.
 */
export function isIdempotentMethod(method: string): boolean {
    return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

export interface RetryInput {
    /** HTTP method of the request that failed. */
    method: string;
    /** Response status, absent for a network failure or timeout. */
    status?: number;
    /** The request failed before a response (dropped socket, DNS, TLS). */
    networkError?: boolean;
    /** Our own deadline expired. Never retried. */
    timeout?: boolean;
    /** Seconds from `Retry-After`, already parsed. `0` is a legitimate value. */
    retryAfterSeconds?: number;
    /** Retries already performed, 0-based. */
    attempt: number;
    /** Total retries allowed. `0` disables retrying. */
    maxRetries: number;
    baseDelayMs?: number;
    jitterMs?: number;
    maxDelayMs?: number;
    /** Injectable for deterministic tests. */
    random?: () => number;
}

export interface RetryDecision {
    retry: boolean;
    /** How long to wait before the next attempt. Meaningless when `retry` is false. */
    delayMs: number;
}

/**
 * Decide whether to replay a failed request, and how long to wait first.
 *
 * `retryAfterSeconds` replaces the exponential term when present — including
 * when it is `0`, which is a legitimate "go now" and must not collapse into the
 * absent case. Jitter is added on both paths so a fleet of clients rate-limited
 * together does not return in lockstep.
 */
export function planRetry(input: RetryInput): RetryDecision {
    const {
        method,
        status,
        networkError = false,
        timeout = false,
        retryAfterSeconds,
        attempt,
        maxRetries,
        baseDelayMs = DEFAULT_BASE_DELAY_MS,
        jitterMs = DEFAULT_JITTER_MS,
        maxDelayMs = DEFAULT_MAX_DELAY_MS,
        random = Math.random,
    } = input;

    const no: RetryDecision = { retry: false, delayMs: 0 };

    if (timeout) return no;
    if (attempt >= maxRetries) return no;

    const idempotent = isIdempotentMethod(method);
    const ambiguous = networkError || (status !== undefined && status >= 500);
    const retryable = status === 429 || (ambiguous && idempotent);
    if (!retryable) return no;

    const jitter = random() * jitterMs;

    if (retryAfterSeconds !== undefined) {
        const advised = retryAfterSeconds * 1000;
        // The server's advice, not ours: honor it or give up, never shorten it.
        if (advised > maxDelayMs) return no;
        return { retry: true, delayMs: advised + jitter };
    }

    const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    return { retry: true, delayMs: exponential + jitter };
}
