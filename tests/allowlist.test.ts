import { describe, it, expect } from 'vitest';
import {
    isRepoAllowed,
    repoFromSource,
    checkSourceAllowed,
    describeAllowlist,
} from '../src/allowlist.js';

// jules-mcp#50432. The fleet has 474 connected sources and a Jules session
// writes a branch and can open a PR, so "which repo may this touch" is the one
// bound worth having. It is also the mechanical form of a rule that currently
// lives only in instructions (avic / simsys / bfr / bbfra in scope; cubuild,
// foreign, option out).
//
// The slice shipped under #50457 guarded one tool. This is the whole surface.

describe('isRepoAllowed', () => {
    it('unset or blank means no restriction — backward compatible', () => {
        for (const raw of [undefined, '', '   ', ',,', ' , ']) {
            expect(isRepoAllowed('anyone/anything', raw)).toBe(true);
        }
    });

    it('matches an exact entry, case-insensitively', () => {
        expect(
            isRepoAllowed('Avicennasis/GrantLoft', 'avicennasis/grantloft'),
        ).toBe(true);
        expect(
            isRepoAllowed('avicennasis/grantloft', 'Avicennasis/GrantLoft'),
        ).toBe(true);
    });

    it('matches an owner wildcard', () => {
        expect(isRepoAllowed('Avicennasis/anything', 'Avicennasis/*')).toBe(
            true,
        );
    });

    // The wildcard compares the WHOLE owner segment. A prefix match would hand
    // `avicious/x` an allowance meant for `avic/*`, which is a different
    // account entirely — the exact shape of a real supply-chain mistake.
    it('does not let an owner wildcard match a longer owner', () => {
        expect(isRepoAllowed('avicious/x', 'avic/*')).toBe(false);
        expect(isRepoAllowed('avic-extra/x', 'avic/*')).toBe(false);
    });

    it('denies a repo absent from a populated list', () => {
        expect(isRepoAllowed('stranger/repo', 'avic/*,simsys/tool')).toBe(
            false,
        );
    });

    it('honours a bare * as allow-everything', () => {
        expect(isRepoAllowed('stranger/repo', '*')).toBe(true);
    });
});

describe('repoFromSource', () => {
    it.each([
        ['sources/github/Avicennasis/GrantLoft', 'Avicennasis/GrantLoft'],
        ['github/Avicennasis/GrantLoft', 'Avicennasis/GrantLoft'],
        ['Avicennasis/GrantLoft', 'Avicennasis/GrantLoft'],
    ])('reads %s as %s', (source, expected) => {
        expect(repoFromSource(source)).toBe(expected);
    });

    // A source shape we cannot decompose must be reported as unknown rather
    // than guessed at. The caller decides what to do with that, and it decides
    // to deny.
    it.each([
        'sources/gitlab/g/o/r',
        'sources/github/only-owner',
        'nonsense',
        '',
    ])('returns undefined for an undecomposable source (%s)', (source) => {
        expect(repoFromSource(source)).toBeUndefined();
    });
});

describe('checkSourceAllowed — the decision the tools call', () => {
    it('allows anything when no allowlist is configured', () => {
        expect(
            checkSourceAllowed('sources/gitlab/weird/shape', undefined).allowed,
        ).toBe(true);
    });

    it('allows a source whose repo is on the list', () => {
        const r = checkSourceAllowed('sources/github/avic/tool', 'avic/*');
        expect(r.allowed).toBe(true);
    });

    it('denies a source whose repo is not on the list, naming both', () => {
        const r = checkSourceAllowed('sources/github/stranger/tool', 'avic/*');
        expect(r.allowed).toBe(false);
        if (r.allowed) throw new Error('unreachable');
        expect(r.repo).toBe('stranger/tool');
        expect(r.message).toContain('stranger/tool');
        expect(r.message).toContain('JULES_ALLOWED_REPOS');
    });

    // FAIL CLOSED. With a list configured and a source we cannot decompose, we
    // cannot show the repo is on the list — and "cannot confirm" must not read
    // as "permit" in a guardrail. The message has to say which of the two
    // denials this is, or the operator debugs the wrong thing.
    it('denies an undecomposable source when a list IS configured', () => {
        const r = checkSourceAllowed('sources/gitlab/weird/shape', 'avic/*');
        expect(r.allowed).toBe(false);
        if (r.allowed) throw new Error('unreachable');
        expect(r.repo).toBeUndefined();
        expect(r.message).toMatch(/could not|unable|not determine/i);
    });
});

describe('describeAllowlist — the startup line', () => {
    // The ticket asks that "unset means no restriction" be logged, because an
    // absent guardrail is invisible otherwise and reads identically to a
    // working one.
    it('says plainly when nothing is restricting', () => {
        expect(describeAllowlist(undefined)).toMatch(/not set|no restriction/i);
        expect(describeAllowlist('')).toMatch(/not set|no restriction/i);
    });

    it('lists the entries when set', () => {
        const line = describeAllowlist('avic/*, simsys/tool');
        expect(line).toContain('avic/*');
        expect(line).toContain('simsys/tool');
    });

    it('never returns an empty string — a silent startup line is no line', () => {
        for (const raw of [undefined, '', 'avic/*']) {
            expect(describeAllowlist(raw).trim().length).toBeGreaterThan(0);
        }
    });
});
