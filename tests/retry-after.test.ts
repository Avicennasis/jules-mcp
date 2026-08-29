import { describe, it, expect } from 'vitest';
import {
    parseRetryAfterSeconds,
    parseRetryAfterMs,
} from '../src/retry-after.js';

// jules-mcp#50648. The hazard is not that a blank header is rejected — it is
// what a blank header is mistaken FOR. `Number('')` is 0 ("retry immediately")
// and `parseInt('', 10)` is NaN, which is falsy in a template so it reads as
// harmless, survives arithmetic, and makes setTimeout fire on the next tick.
// Both collapse "the server gave no advice" into "hammer it now".
//
// The discriminating case in this file is '0': a legitimate zero that must stay
// zero. A guard written as `if (!seconds) return undefined` passes every other
// assertion here and breaks that one, which is exactly the mistake this suite
// exists to catch.

describe('parseRetryAfterSeconds — absent means absent, not zero', () => {
    const absent: [string, string | null | undefined][] = [
        ['null', null],
        ['undefined', undefined],
        ['empty string', ''],
        ['whitespace only', '   '],
        ['tab and newline', '\t\n '],
    ];
    it.each(absent)('%s -> undefined', (_label, input) => {
        expect(parseRetryAfterSeconds(input)).toBeUndefined();
    });

    it('never returns NaN for garbage — undefined instead', () => {
        for (const bad of ['abc', 'soon', '12abc', '1.5.2', '--3', '']) {
            const got = parseRetryAfterSeconds(bad);
            expect(got === undefined || Number.isFinite(got)).toBe(true);
            expect(Number.isNaN(got as number)).toBe(false);
        }
        expect(parseRetryAfterSeconds('abc')).toBeUndefined();
    });

    it("'12abc' is rejected rather than read as 12", () => {
        // parseInt would return 12 here and silently accept a malformed header
        // as advice. Anchored digits-only is the point.
        expect(parseRetryAfterSeconds('12abc')).toBeUndefined();
    });
});

describe('parseRetryAfterSeconds — delta-seconds', () => {
    it("'0' is a LEGITIMATE zero and stays 0", () => {
        // The case that separates a correct guard from `if (!seconds)`.
        expect(parseRetryAfterSeconds('0')).toBe(0);
    });

    it("'120' -> 120", () => {
        expect(parseRetryAfterSeconds('120')).toBe(120);
    });

    it('surrounding whitespace is trimmed, not rejected', () => {
        expect(parseRetryAfterSeconds('  120  ')).toBe(120);
    });

    it("'-5' clamps to 0 rather than going negative", () => {
        expect(parseRetryAfterSeconds('-5')).toBe(0);
    });
});

describe('parseRetryAfterSeconds — HTTP-date form', () => {
    const now = Date.parse('2026-08-29T12:00:00Z');

    it('a future date resolves to seconds from now', () => {
        expect(
            parseRetryAfterSeconds('Sat, 29 Aug 2026 12:02:00 GMT', now),
        ).toBe(120);
    });

    it('a past date clamps to 0, matching the delta-seconds clamp', () => {
        expect(
            parseRetryAfterSeconds('Sat, 29 Aug 2026 11:00:00 GMT', now),
        ).toBe(0);
    });

    it('an unparseable date is undefined, not NaN', () => {
        expect(
            parseRetryAfterSeconds('Notaday, 32 Foo 2026 99:99:99 GMT', now),
        ).toBeUndefined();
    });
});

describe('parseRetryAfterMs', () => {
    it('scales seconds to milliseconds', () => {
        expect(parseRetryAfterMs('120')).toBe(120_000);
        expect(parseRetryAfterMs('0')).toBe(0);
    });

    it('propagates undefined so callers fall back to their own backoff', () => {
        // The criterion "absent header falls back to exponential backoff, not
        // to zero delay" is a property of this return value: undefined is
        // distinguishable from 0, and 0 is not.
        expect(parseRetryAfterMs('')).toBeUndefined();
        expect(parseRetryAfterMs(null)).toBeUndefined();
        expect(parseRetryAfterMs('   ')).toBeUndefined();
        expect(parseRetryAfterMs('0')).not.toBeUndefined();
    });

    it('never hands a NaN to a sleep', () => {
        for (const h of ['', '   ', 'abc', null, undefined, '0', '120', '-5']) {
            const ms = parseRetryAfterMs(h as string | null | undefined);
            expect(Number.isNaN(ms as number)).toBe(false);
        }
    });
});
