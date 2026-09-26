/**
 * Layered output budgets + in-band recovery hints (Redmine #50417).
 *
 * The defect this replaces: the only truncation was `truncatePatch`'s line cap,
 * which told the caller nothing about how to see the rest, so an LLM that hit
 * it had no next move. These tests pin the two halves of the fix — that a
 * truncation names the exact tool call which expands the elided content, and
 * that when nothing can recover it the message SAYS SO rather than implying a
 * retry that cannot work.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyCharBudget, OUTPUT_BUDGETS } from '../src/formatters.js';
import { registerActivityTools } from '../src/tools/activities.js';
import { registerDiffTools } from '../src/tools/diff.js';
import type { JulesClient } from '../src/jules-client.js';
import type { Activity, Session } from '../src/types.js';

vi.mock('../src/audit.js', () => ({
    emitAudit: vi.fn().mockResolvedValue(undefined),
}));

// Bigger than the LARGEST budget under test (detail = 8000), so the
// unrecoverable-detail case actually truncates.
const bigMessage = 'y'.repeat(20_000);

const bigActivity: Activity = {
    name: 'sessions/abc/activities/77',
    id: '77',
    description: 'Agent sent message',
    createTime: '2026-01-01T00:00:00Z',
    originator: 'agent',
    agentMessaged: { agentMessage: bigMessage },
};

function makeServer() {
    const tools = new Map<string, { handler: Function }>();
    const server: any = {
        tool: vi.fn(
            (name: string, _desc: string, _schema: any, handler: Function) => {
                tools.set(name, { handler });
            },
        ),
    };
    return { server, tools };
}

describe('applyCharBudget', () => {
    it('leaves text under the budget untouched', () => {
        const text = 'short';
        expect(applyCharBudget(text, 100, 'x')).toBe(text);
    });

    it('leaves text exactly at the budget untouched', () => {
        const text = 'z'.repeat(100);
        expect(applyCharBudget(text, 100, null)).toBe(text);
    });

    it('truncates and names the recovery call', () => {
        const out = applyCharBudget(
            'a'.repeat(500),
            100,
            'jules_pull_session with session_id="s1"',
        );
        expect(out.length).toBeLessThan(500);
        expect(out).toContain('jules_pull_session with session_id="s1"');
        expect(out).toContain('To read the rest, call');
        // The count is reported so the caller can judge whether it is worth it.
        expect(out).toContain('400 of 500 characters omitted');
    });

    it('says outright when the remainder is unrecoverable', () => {
        const out = applyCharBudget('a'.repeat(500), 100, null);
        expect(out).toContain('NOT retrievable');
        // Crucially, it must NOT invite a retry that cannot work.
        expect(out).not.toContain('To read the rest');
    });

    it('exposes distinct budgets per surface', () => {
        expect(OUTPUT_BUDGETS.listItem).toBeLessThan(OUTPUT_BUDGETS.listPage);
        expect(OUTPUT_BUDGETS.detail).toBeGreaterThan(OUTPUT_BUDGETS.diff);
    });
});

describe('budget hints name a real tool call', () => {
    it('jules_list_activities names jules_get_activity with the activity id', async () => {
        const client: Partial<JulesClient> = {
            listActivities: vi
                .fn()
                .mockResolvedValue({ activities: [bigActivity] }),
        };
        const localTools = makeServer();
        registerActivityTools(localTools.server, client as JulesClient);

        const result = await localTools.tools
            .get('jules_list_activities')!
            .handler({ session_id: 'sessions/abc', page_size: 10 });

        const text = result.content[0].text;
        expect(text).toContain('jules_get_activity');
        expect(text).toContain('activity_id="77"');
        expect(text).toContain('session_id="sessions/abc"');
    });

    it('jules_get_activity calls it unrecoverable, not retryable', async () => {
        const client: Partial<JulesClient> = {
            getActivity: vi.fn().mockResolvedValue(bigActivity),
        };
        const localTools = makeServer();
        registerActivityTools(localTools.server, client as JulesClient);
        const result = await localTools.tools
            .get('jules_get_activity')!
            .handler({ session_id: 'sessions/abc', activity_id: '77' });

        const text = result.content[0].text;
        expect(text).toContain('NOT retrievable');
        expect(text).not.toContain('To read the rest');
    });

    it('jules_get_session_diff names jules_pull_session for the raw patch', async () => {
        const hugePatch = [
            'diff --git a/big.ts b/big.ts',
            '@@ -1,1 +1,2000 @@',
            ...Array.from({ length: 2_000 }, (_, i) => `+line ${i}`),
        ].join('\n');
        const diffActivity: Activity = {
            name: 'sessions/abc/activities/9',
            id: '9',
            description: 'change set',
            createTime: '2026-01-01T00:00:00Z',
            originator: 'agent',
            artifacts: [
                {
                    changeSet: {
                        gitPatch: { unidiffPatch: hugePatch },
                    },
                },
            ],
        } as Activity;
        const session = {
            name: 'sessions/abc',
            id: 'abc',
            state: 'COMPLETED',
            url: 'https://jules/abc',
            sourceContext: { source: 'sources/github/o/r' },
            createTime: '',
            updateTime: '',
        } as Session;

        const client: Partial<JulesClient> = {
            getSession: vi.fn().mockResolvedValue(session),
            listActivities: vi
                .fn()
                .mockResolvedValue({ activities: [diffActivity] }),
        };
        const localTools = makeServer();
        registerDiffTools(localTools.server, client as JulesClient);

        const result = await localTools.tools
            .get('jules_get_session_diff')!
            .handler({
                session_id: 'sessions/abc',
                summary: false,
                include_lockfiles: false,
                include_journal_files: false,
            });

        const text = result.content[0].text;
        expect(text).toContain('jules_pull_session');
        expect(text).toContain('session_id="sessions/abc"');
    });
});
