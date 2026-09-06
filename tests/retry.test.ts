import { describe, it, expect } from 'vitest';
import { isIdempotentMethod, planRetry } from '../src/retry.js';

// jules-mcp#50643, consolidating #50416 / #50447 / #50451 / #50461.
// Adapted from Yuuqq/jules-dispatch (MIT), src/client.ts:37-101.
//
// The distinction this module exists for: a 429 means the request was REJECTED
// WITHOUT BEING PROCESSED, so replaying it is safe for any method including
// POST. A 5xx or a dropped socket is AMBIGUOUS — the session may already have
// been created — so replaying it can double-create and burn quota that has no
// measured daily ceiling (#50428). georgeracu's server retries POST /sessions
// on 5xx with no idempotency key; that is the bug we are deliberately not
// copying.
//
// The discriminating pair is therefore (429, POST) -> retry and (503, POST) ->
// no retry. A predicate written as `status === 429 || status >= 500` passes
// every other assertion in this file and fails exactly those.

const det = { random: () => 0.5, baseDelayMs: 100, jitterMs: 200 };

describe('isIdempotentMethod', () => {
    it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])(
        '%s is idempotent',
        (m) => {
            expect(isIdempotentMethod(m)).toBe(true);
        },
    );

    it.each(['POST', 'PATCH', 'CONNECT', 'TRACE'])(
        '%s is not idempotent',
        (m) => {
            expect(isIdempotentMethod(m)).toBe(false);
        },
    );

    it('is case-insensitive', () => {
        expect(isIdempotentMethod('get')).toBe(true);
        expect(isIdempotentMethod('post')).toBe(false);
    });
});

describe('planRetry — 429 is safe to replay for any method', () => {
    it.each(['GET', 'POST', 'DELETE', 'PATCH'])('retries a 429 on %s', (m) => {
        expect(
            planRetry({ method: m, status: 429, attempt: 0, maxRetries: 3 })
                .retry,
        ).toBe(true);
    });
});

describe('planRetry — 5xx and network failures are ambiguous', () => {
    it.each([500, 502, 503, 504])(
        'retries a %i on GET (idempotent)',
        (status) => {
            expect(
                planRetry({ method: 'GET', status, attempt: 0, maxRetries: 3 })
                    .retry,
            ).toBe(true);
        },
    );

    it.each([500, 502, 503, 504])(
        'does NOT retry a %i on POST — the session may already exist',
        (status) => {
            expect(
                planRetry({ method: 'POST', status, attempt: 0, maxRetries: 3 })
                    .retry,
            ).toBe(false);
        },
    );

    it('retries a network error on GET but not on POST', () => {
        expect(
            planRetry({
                method: 'GET',
                networkError: true,
                attempt: 0,
                maxRetries: 3,
            }).retry,
        ).toBe(true);
        expect(
            planRetry({
                method: 'POST',
                networkError: true,
                attempt: 0,
                maxRetries: 3,
            }).retry,
        ).toBe(false);
    });
});

describe('planRetry — failures that must never be replayed', () => {
    it.each([400, 401, 403, 404, 409, 422])(
        'does not retry a %i even on GET',
        (status) => {
            expect(
                planRetry({ method: 'GET', status, attempt: 0, maxRetries: 3 })
                    .retry,
            ).toBe(false);
        },
    );

    // A timeout retries for IDEMPOTENT METHODS ONLY (#50447, operator decision
    // 2026-09-06 overruling #50643's blanket never-retry). A slow read is worth
    // a second chance; a slow POST is the double-submit hazard, because a
    // deadline that expires client-side says nothing about whether the server
    // processed the request. That is the same ambiguity as a 5xx or a dropped
    // socket, and it gets the same answer.
    it('retries a timeout on GET', () => {
        expect(
            planRetry({
                method: 'GET',
                timeout: true,
                attempt: 0,
                maxRetries: 3,
            }).retry,
        ).toBe(true);
    });

    it.each(['HEAD', 'OPTIONS', 'PUT', 'DELETE'])(
        'retries a timeout on %s',
        (method) => {
            expect(
                planRetry({ method, timeout: true, attempt: 0, maxRetries: 3 })
                    .retry,
            ).toBe(true);
        },
    );

    // The half that must NOT change. A timed-out create may already have made a
    // session, and Jules has no idempotency key.
    it.each(['POST', 'PATCH'])(
        'does NOT retry a timeout on %s — it may already have landed',
        (method) => {
            expect(
                planRetry({ method, timeout: true, attempt: 0, maxRetries: 3 })
                    .retry,
            ).toBe(false);
        },
    );

    // Precedence guard. A timeout means no response arrived, so a status
    // riding alongside it is not a server verdict -- the 429 fast path (safe
    // for every method) must not unlock a timed-out POST. Without this, a
    // predicate written as `status === 429 || ...` retries the exact case the
    // idempotency split exists to prevent.
    it('a 429 alongside a timeout does NOT unlock a POST retry', () => {
        expect(
            planRetry({
                method: 'POST',
                timeout: true,
                status: 429,
                attempt: 0,
                maxRetries: 3,
            }).retry,
        ).toBe(false);
    });

    it('still respects the retry budget for timeouts', () => {
        expect(
            planRetry({
                method: 'GET',
                timeout: true,
                attempt: 3,
                maxRetries: 3,
            }).retry,
        ).toBe(false);
    });

    // A timeout carries no Retry-After, so it backs off exponentially like any
    // other ambiguous failure rather than getting its own schedule.
    it('backs a timeout off exponentially', () => {
        expect(
            planRetry({
                method: 'GET',
                timeout: true,
                attempt: 1,
                maxRetries: 3,
                ...det,
            }).delayMs,
        ).toBe(200 + 100);
    });

    it('stops once the retry budget is spent', () => {
        expect(
            planRetry({ method: 'GET', status: 503, attempt: 2, maxRetries: 3 })
                .retry,
        ).toBe(true);
        expect(
            planRetry({ method: 'GET', status: 503, attempt: 3, maxRetries: 3 })
                .retry,
        ).toBe(false);
    });

    it('never retries when maxRetries is 0', () => {
        expect(
            planRetry({ method: 'GET', status: 429, attempt: 0, maxRetries: 0 })
                .retry,
        ).toBe(false);
    });
});

describe('planRetry — delay', () => {
    it('backs off exponentially with jitter on both halves', () => {
        const at = (attempt: number) =>
            planRetry({
                method: 'GET',
                status: 503,
                attempt,
                maxRetries: 5,
                ...det,
            }).delayMs;

        // base * 2^attempt + random() * jitterMs
        expect(at(0)).toBe(100 + 100);
        expect(at(1)).toBe(200 + 100);
        expect(at(2)).toBe(400 + 100);
    });

    it('honors Retry-After in place of the exponential term, still jittered', () => {
        const plan = planRetry({
            method: 'POST',
            status: 429,
            retryAfterSeconds: 7,
            attempt: 2,
            maxRetries: 5,
            ...det,
        });
        expect(plan.delayMs).toBe(7000 + 100);
    });

    it('preserves a literal Retry-After of 0 rather than falling back', () => {
        // parseRetryAfterSeconds returns 0 for a legitimate "0" and undefined
        // for absent. Collapsing them would turn "no advice" into "hammer it".
        const plan = planRetry({
            method: 'POST',
            status: 429,
            retryAfterSeconds: 0,
            attempt: 3,
            maxRetries: 5,
            ...det,
        });
        expect(plan.delayMs).toBe(0 + 100);
    });

    it('adds jitter that actually varies with the source of randomness', () => {
        const one = planRetry({
            method: 'GET',
            status: 503,
            attempt: 0,
            maxRetries: 3,
            baseDelayMs: 100,
            jitterMs: 200,
            random: () => 0,
        }).delayMs;
        const two = planRetry({
            method: 'GET',
            status: 503,
            attempt: 0,
            maxRetries: 3,
            baseDelayMs: 100,
            jitterMs: 200,
            random: () => 1,
        }).delayMs;
        expect(one).toBe(100);
        expect(two).toBe(300);
    });
});

// #50461. Without jitter, N parallel sessions rate-limited together retry in
// lockstep and re-collide — which is precisely the failure mode our `parallel`
// fan-out in jules_run_task creates. This uses the REAL default randomness: a
// test that injects `random` cannot show the shipped default is jittered at all.
describe('planRetry — parallel callers do not retry in lockstep', () => {
    it('produces distinct delays across concurrent identical calls', () => {
        const delays = Array.from(
            { length: 20 },
            () =>
                planRetry({
                    method: 'GET',
                    status: 429,
                    attempt: 0,
                    maxRetries: 3,
                }).delayMs,
        );

        // 20 draws from a continuous jitter range collide with probability ~0.
        // A jitterMs of 0, or jitter dropped from the shipped defaults, gives
        // exactly one distinct value.
        expect(new Set(delays).size).toBeGreaterThan(1);
    });
});

describe('planRetry — a wait longer than we are willing to block is not a retry', () => {
    it('declines when Retry-After exceeds maxDelayMs', () => {
        // Sleeping an hour inside an MCP tool call is worse than failing: the
        // caller gets no answer and no chance to decide. Surface the error with
        // its retry-after instead.
        const plan = planRetry({
            method: 'POST',
            status: 429,
            retryAfterSeconds: 3600,
            attempt: 0,
            maxRetries: 3,
            maxDelayMs: 30_000,
            ...det,
        });
        expect(plan.retry).toBe(false);
    });

    it('still retries a wait inside the cap', () => {
        const plan = planRetry({
            method: 'POST',
            status: 429,
            retryAfterSeconds: 5,
            attempt: 0,
            maxRetries: 3,
            maxDelayMs: 30_000,
            ...det,
        });
        expect(plan.retry).toBe(true);
        expect(plan.delayMs).toBe(5000 + 100);
    });

    it('caps the exponential term rather than declining on it', () => {
        // An exponential delay is ours, not the server's advice — clamping it
        // keeps late attempts bounded without giving up the attempt.
        const plan = planRetry({
            method: 'GET',
            status: 503,
            attempt: 20,
            maxRetries: 30,
            baseDelayMs: 100,
            jitterMs: 0,
            maxDelayMs: 30_000,
            random: () => 0,
        });
        expect(plan.retry).toBe(true);
        expect(plan.delayMs).toBe(30_000);
    });
});
