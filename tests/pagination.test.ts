import { describe, it, expect, vi } from 'vitest';
import { registerSourceTools } from '../src/tools/sources.js';
import { registerSessionTools } from '../src/tools/sessions.js';
import type { JulesClient } from '../src/jules-client.js';
import {
    guardPageToken,
    guardPaginationDeadline,
    PaginationLoopError,
    PAGINATION_DEADLINE_MS,
} from '../src/pagination.js';

// jules-mcp#50645. A repeated nextPageToken is never a legitimate server state,
// so the loop must fail loudly rather than re-fetch the same page to the cap and
// report a truncated scan built from duplicate rows. `suggestions_only` decides
// "no matches exist" from one of these walks, so duplicates make the judgement
// wrong, not merely imprecise.

describe('guardPageToken', () => {
    it('accepts distinct tokens — normal pagination is unaffected', () => {
        const seen = new Set<string>();
        expect(() => {
            for (const t of ['a', 'b', 'c', 'd']) {
                guardPageToken(t, seen, 'sources');
            }
        }).not.toThrow();
        expect(seen.size).toBe(4);
    });

    it('throws on a repeat, naming the resource and the token', () => {
        const seen = new Set<string>();
        guardPageToken('tok-1', seen, 'sources');
        expect(() => guardPageToken('tok-1', seen, 'sources')).toThrow(
            PaginationLoopError,
        );
        try {
            guardPageToken('tok-1', seen, 'sources');
        } catch (e) {
            expect((e as Error).message).toContain('sources');
            expect((e as Error).message).toContain('tok-1');
        }
    });

    it('cannot be defeated by an empty-string token', () => {
        // '' is falsy, so it already terminates every caller's `while (token)`
        // and can never drive a loop. Recording it would make two independent
        // "no more pages" replies look like a repeat and throw on a healthy walk.
        const seen = new Set<string>();
        expect(() => {
            guardPageToken('', seen, 'sources');
            guardPageToken('', seen, 'sources');
            guardPageToken(undefined, seen, 'sources');
            guardPageToken(undefined, seen, 'sources');
        }).not.toThrow();
        expect(seen.size).toBe(0);
    });
});

describe('guardPaginationDeadline', () => {
    it('does not throw inside the deadline', () => {
        const started = 1_000_000;
        expect(() =>
            guardPaginationDeadline(started, 'sessions', 60_000, started + 100),
        ).not.toThrow();
    });

    it('throws once past the deadline, naming the resource', () => {
        const started = 1_000_000;
        expect(() =>
            guardPaginationDeadline(
                started,
                'sessions',
                60_000,
                started + 60_001,
            ),
        ).toThrow(/sessions/);
    });

    it('has a finite default deadline', () => {
        expect(Number.isFinite(PAGINATION_DEADLINE_MS)).toBe(true);
        expect(PAGINATION_DEADLINE_MS).toBeGreaterThan(0);
    });
});

// The guards above are unit-tested, but a unit test of a helper says nothing
// about whether the real loops CALL it. These drive the actual registered tool
// handlers with a mocked client, so the artifact under test is the shipped
// pagination loop rather than a copy of it written in this file. A harness that
// re-implements the loop passes whether or not sources.ts was ever touched.

function harness(
    client: Partial<JulesClient>,
    register: 'sources' | 'sessions',
) {
    const registeredTools = new Map<string, { handler: Function }>();
    const mockServer: any = {
        tool: vi.fn((name: string, _d: string, _s: any, handler: Function) => {
            registeredTools.set(name, { handler });
        }),
    };
    if (register === 'sources') {
        registerSourceTools(mockServer, client as JulesClient);
    } else {
        registerSessionTools(mockServer, client as JulesClient);
    }
    return registeredTools;
}

/** The tools catch and format errors, so read the payload rather than expecting a throw. */
function textOf(result: any): string {
    return result.content[0].text as string;
}

describe('jules_list_sources — the real loop (#50645)', () => {
    it('a constant nextPageToken errors instead of spinning to the page cap', async () => {
        const listSources = vi
            .fn()
            .mockResolvedValue({ sources: [], nextPageToken: 'same-forever' });
        const tools = harness({ listSources }, 'sources');
        const handler = tools.get('jules_list_sources')!.handler;

        const out = await handler({ max_pages: 20 });

        expect(textOf(out)).toContain('repeated page token');
        expect(textOf(out)).toContain('sources');
        // The repeat is caught on the second fetch — nowhere near the cap of 20.
        expect(listSources).toHaveBeenCalledTimes(2);
    });

    it('distinct tokens paginate normally and are not flagged', async () => {
        const pages = ['a', 'b', undefined];
        let i = 0;
        const listSources = vi.fn().mockImplementation(async () => ({
            sources: [{ name: `sources/github/owner/repo-${i}` }],
            nextPageToken: pages[i++],
        }));
        const tools = harness({ listSources }, 'sources');
        const handler = tools.get('jules_list_sources')!.handler;

        const out = await handler({ max_pages: 20 });

        expect(textOf(out)).not.toContain('repeated page token');
        expect(listSources).toHaveBeenCalledTimes(3);
    });
});

describe('jules_list_sessions — the real loop (#50645)', () => {
    it('a constant nextPageToken errors instead of spinning to the page cap', async () => {
        const listSessions = vi
            .fn()
            .mockResolvedValue({ sessions: [], nextPageToken: 'same-forever' });
        const tools = harness({ listSessions }, 'sessions');
        const handler = tools.get('jules_list_sessions')!.handler;

        const out = await handler({ source: 'owner/repo', max_pages: 20 });

        expect(textOf(out)).toContain('repeated page token');
        expect(textOf(out)).toContain('sessions');
        expect(listSessions).toHaveBeenCalledTimes(2);
    });
});
