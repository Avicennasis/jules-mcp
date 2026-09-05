import { describe, it, expect } from 'vitest';
import {
    normalizeResourceName,
    TERMINAL_STATES,
    SESSION_STATES,
    LEGACY_SESSION_STATES,
    isActiveState,
} from '../src/types.js';

describe('normalizeResourceName', () => {
    it('prefixes a bare ID', () => {
        expect(normalizeResourceName('abc123', 'sessions')).toBe(
            'sessions/abc123',
        );
    });

    it('passes through an already-prefixed name', () => {
        expect(normalizeResourceName('sessions/abc123', 'sessions')).toBe(
            'sessions/abc123',
        );
    });

    it('handles sources with nested paths', () => {
        expect(normalizeResourceName('github/owner/repo', 'sources')).toBe(
            'sources/github/owner/repo',
        );
    });

    it('passes through sources already prefixed', () => {
        expect(
            normalizeResourceName('sources/github/owner/repo', 'sources'),
        ).toBe('sources/github/owner/repo');
    });
});

describe('TERMINAL_STATES', () => {
    it('contains COMPLETED and FAILED', () => {
        expect(TERMINAL_STATES.has('COMPLETED')).toBe(true);
        expect(TERMINAL_STATES.has('FAILED')).toBe(true);
    });

    it('does not contain IN_PROGRESS', () => {
        expect(TERMINAL_STATES.has('IN_PROGRESS')).toBe(false);
    });
});

// --- SessionState is an OPEN union (#50647, #50777) ---
//
// Four community repos gave four state vocabularies and no two agree. The union
// of names claimed beyond ours is at least CANCELLED, CANCELED,
// COMPLETED_UNKNOWN, PENDING, RUNNING, AWAITING_USER_INPUT, WAITING_FOR_APPROVAL
// and UNKNOWN — several of them guesses (#50777). The enumeration cannot be
// completed by collecting more names from third parties, so the fix is a safe
// default branch, not a longer list.
//
// The union being OPEN is a compile-time property and tests are excluded from
// tsconfig, so it cannot be asserted here. The proof lives in src/types.ts,
// where `npm run build` checks it.

describe('SESSION_STATES vocabulary', () => {
    it('lists only the states the current API documents', () => {
        expect([...SESSION_STATES]).toEqual([
            'STATE_UNSPECIFIED',
            'QUEUED',
            'PLANNING',
            'AWAITING_PLAN_APPROVAL',
            'AWAITING_USER_FEEDBACK',
            'IN_PROGRESS',
            'PAUSED',
            'FAILED',
            'COMPLETED',
        ]);
    });

    it('keeps legacy and in-the-wild names in a separate list', () => {
        // Kept apart so the current vocabulary stays honest: these are names we
        // must TOLERATE, not names the API is documented to send.
        expect([...LEGACY_SESSION_STATES]).toContain('PENDING');
        expect([...LEGACY_SESSION_STATES]).toContain('RUNNING');
        expect([...LEGACY_SESSION_STATES]).toContain('AWAITING_USER_INPUT');
        expect([...LEGACY_SESSION_STATES]).toContain('CANCELLED');
        expect([...LEGACY_SESSION_STATES]).toContain('CANCELED');
        expect([...LEGACY_SESSION_STATES]).toContain('COMPLETED_UNKNOWN');
    });
});

describe('TERMINAL_STATES', () => {
    it.each([
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'CANCELED',
        'COMPLETED_UNKNOWN',
    ])('%s is terminal', (state) => {
        expect(TERMINAL_STATES.has(state)).toBe(true);
    });

    it('carries BOTH cancelled spellings', () => {
        // A check matching one spelling silently misses the other. This is the
        // assertion that fails if someone "tidies" the duplicate away.
        expect(TERMINAL_STATES.has('CANCELLED')).toBe(true);
        expect(TERMINAL_STATES.has('CANCELED')).toBe(true);
    });

    it.each([
        'PAUSED',
        'QUEUED',
        'PLANNING',
        'IN_PROGRESS',
        'PENDING',
        'RUNNING',
    ])('%s is NOT terminal', (state) => {
        expect(TERMINAL_STATES.has(state)).toBe(false);
    });

    it('does not contain PAUSED — a paused session is resumable, not finished', () => {
        expect(TERMINAL_STATES.has('PAUSED')).toBe(false);
    });
});

describe('isActiveState — the predicate the poll loop branches on', () => {
    it.each([
        'STATE_UNSPECIFIED',
        'QUEUED',
        'PLANNING',
        'IN_PROGRESS',
        'PENDING',
        'RUNNING',
    ])('%s means keep polling', (state) => {
        expect(isActiveState(state)).toBe(true);
    });

    it.each([
        'COMPLETED',
        'FAILED',
        'CANCELED',
        'COMPLETED_UNKNOWN',
        'PAUSED',
        'AWAITING_PLAN_APPROVAL',
        'AWAITING_USER_FEEDBACK',
        'AWAITING_USER_INPUT',
    ])('%s means stop', (state) => {
        expect(isActiveState(state)).toBe(false);
    });

    // The whole point: an unrecognised state must NOT read as "keep polling".
    // Anything else and a finished session polls to the 600s deadline and is
    // then reported as a timeout, which is not what happened.
    it.each([
        'WAITING_FOR_APPROVAL',
        'UNKNOWN',
        'A_STATE_INVENTED_IN_2027',
        '',
    ])('an unrecognised state (%s) is NOT active', (state) => {
        expect(isActiveState(state)).toBe(false);
    });
});
