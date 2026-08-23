import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerConvenienceTools } from '../../src/tools/convenience.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { Session } from '../../src/types.js';

vi.mock('../../src/audit.js', () => ({
    emitAudit: vi.fn().mockResolvedValue(undefined),
}));

describe('convenience tools', () => {
    let mockServer: any;
    let mockClient: Partial<JulesClient>;
    let registeredTools: Map<string, { handler: Function }>;

    beforeEach(() => {
        vi.resetAllMocks();
        registeredTools = new Map();
        mockServer = {
            tool: vi.fn(
                (
                    name: string,
                    _desc: string,
                    _schema: any,
                    handler: Function,
                ) => {
                    registeredTools.set(name, { handler });
                },
            ),
        };

        const sessionSequence: Session[] = [
            {
                name: 's/1',
                id: '1',
                prompt: 'p',
                sourceContext: { source: 's' },
                state: 'QUEUED',
                createTime: '',
                updateTime: '',
                url: '',
            },
            {
                name: 's/1',
                id: '1',
                prompt: 'p',
                sourceContext: { source: 's' },
                state: 'AWAITING_PLAN_APPROVAL',
                createTime: '',
                updateTime: '',
                url: '',
            },
            {
                name: 's/1',
                id: '1',
                prompt: 'p',
                sourceContext: { source: 's' },
                state: 'IN_PROGRESS',
                createTime: '',
                updateTime: '',
                url: '',
            },
            {
                name: 's/1',
                id: '1',
                prompt: 'p',
                sourceContext: { source: 's' },
                state: 'COMPLETED',
                createTime: '',
                updateTime: '',
                url: '',
                outputs: [
                    {
                        pullRequest: {
                            url: 'https://pr',
                            title: 'PR',
                            description: 'd',
                        },
                    },
                ],
            },
        ];
        let callCount = 0;

        mockClient = {
            createSession: vi.fn().mockResolvedValue(sessionSequence[0]),
            getSession: vi.fn().mockImplementation(async () => {
                callCount++;
                return sessionSequence[
                    Math.min(callCount, sessionSequence.length - 1)
                ];
            }),
            approvePlan: vi.fn().mockResolvedValue(sessionSequence[2]),
        };

        registerConvenienceTools(mockServer, mockClient as JulesClient);
    });

    it('registers jules_run_task', () => {
        expect(registeredTools.has('jules_run_task')).toBe(true);
    });

    it('runs through create → poll → approve → poll → complete', async () => {
        const handler = registeredTools.get('jules_run_task')!.handler;
        const result = await handler({
            prompt: 'fix bug',
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'need fix',
            auto_approve: true,
            poll_interval_ms: 10, // fast for tests
            timeout_ms: 5000,
        });
        expect(mockClient.createSession).toHaveBeenCalled();
        expect(mockClient.approvePlan).toHaveBeenCalled();
        expect(result.content[0].text).toContain('COMPLETED');
    });
});

describe('run_task parallel mode (B1-119)', () => {
    it('polls all parallel sessions to completion and reports per-session outcomes', async () => {
        const registeredTools = new Map<string, { handler: Function }>();
        const mockServer: any = {
            tool: vi.fn(
                (
                    name: string,
                    _desc: string,
                    _schema: any,
                    handler: Function,
                ) => {
                    registeredTools.set(name, { handler });
                },
            ),
        };

        const makeSession = (id: string, state: string): Session =>
            ({
                name: `sessions/${id}`,
                id,
                prompt: 'p',
                sourceContext: { source: 's' },
                state,
                createTime: '',
                updateTime: '',
                url: `https://jules/${id}`,
            }) as Session;

        // Per-session state machines keyed by session id
        const states: Record<string, string[]> = {
            a: ['AWAITING_PLAN_APPROVAL', 'IN_PROGRESS', 'COMPLETED'],
            b: ['IN_PROGRESS', 'COMPLETED'],
        };
        const cursor: Record<string, number> = { a: 0, b: 0 };
        let created = 0;

        const mockClient: Partial<JulesClient> = {
            createSession: vi.fn().mockImplementation(async () => {
                created++;
                const id = created === 1 ? 'a' : 'b';
                return makeSession(id, 'QUEUED');
            }),
            getSession: vi.fn().mockImplementation(async (id: string) => {
                const seq = states[id]!;
                const idx = Math.min(cursor[id]!, seq.length - 1);
                cursor[id]!++;
                return makeSession(id, seq[idx]!);
            }),
            approvePlan: vi
                .fn()
                .mockImplementation(async (id: string) =>
                    makeSession(id, 'IN_PROGRESS'),
                ),
        };

        registerConvenienceTools(mockServer, mockClient as JulesClient);
        const handler = registeredTools.get('jules_run_task')!.handler;

        const result = await handler({
            prompt: 'fix bug',
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'fan out',
            auto_approve: true,
            poll_interval_ms: 5,
            timeout_ms: 5000,
            parallel: 2,
        });

        const body = JSON.parse(result.content[0].text);
        expect(body.status).toBe('OK');
        expect(body.message).toBe(
            '2/2 parallel sessions reached a terminal state.',
        );
        expect(body.sessions).toHaveLength(2);
        for (const s of body.sessions) {
            expect(s.outcome).toBe('terminal');
            expect(s.state).toBe('COMPLETED');
        }
        // Session 'a' needed plan approval — the poller must have approved it
        expect(mockClient.approvePlan).toHaveBeenCalledWith('a');
        expect(mockClient.createSession).toHaveBeenCalledTimes(2);
    });
});

// #50: TERMINAL_STATES is {COMPLETED, FAILED} and pollToCompletion only
// short-circuits on the two AWAITING_* states, so a PAUSED session fell
// through to sleep-and-repoll every iteration and burned the whole deadline
// (10 minutes by default) before reporting the wrong outcome. PAUSED is
// reachable in normal use — archiving a session puts it there.
describe('jules_run_task with a PAUSED session (#50)', () => {
    const paused: Session = {
        name: 's/9',
        id: '9',
        prompt: 'p',
        sourceContext: { source: 'sources/github/o/r' },
        state: 'PAUSED',
        createTime: '',
        updateTime: '',
        url: 'u',
    };

    const build = () => {
        const registered = new Map<string, { handler: Function }>();
        const server = {
            tool: vi.fn((n: string, _d: string, _s: any, h: Function) => {
                registered.set(n, { handler: h });
            }),
        };
        const client = {
            createSession: vi.fn().mockResolvedValue(paused),
            getSession: vi.fn().mockResolvedValue(paused),
            approvePlan: vi.fn(),
        } as unknown as JulesClient;
        registerConvenienceTools(server as any, client);
        return { registered, client };
    };

    const args = {
        prompt: 'p',
        source: 'github/o/r',
        starting_branch: 'main',
        reason: 'r',
        poll_interval_ms: 10,
        timeout_ms: 400,
    };

    it('returns promptly instead of burning the deadline', async () => {
        const { registered } = build();
        const t0 = Date.now();
        await registered.get('jules_run_task')!.handler(args);
        // With the bug this loops until timeout_ms (400ms) elapses.
        expect(Date.now() - t0).toBeLessThan(200);
    });

    it('does not re-poll a session that cannot progress on its own', async () => {
        const { registered, client } = build();
        await registered.get('jules_run_task')!.handler(args);
        // With the bug this is ~40 calls at a 10ms interval over 400ms.
        expect(
            (client.getSession as any).mock.calls.length,
        ).toBeLessThanOrEqual(1);
    });

    it('reports it as paused, not as a timeout and not as success', async () => {
        const { registered } = build();
        const res = await registered.get('jules_run_task')!.handler(args);
        const text = String(res.content[0].text);
        expect(text).toMatch(/paused/i);
        expect(text).not.toMatch(/timed out/i);
    });

    it('does not report a paused session as a completed run', async () => {
        // The single-mode if-chain falls through to a bare formatSession(),
        // so an unhandled outcome renders exactly like success. TypeScript
        // cannot catch that — only an assertion on the output can.
        const { registered } = build();
        const res = await registered.get('jules_run_task')!.handler(args);
        const text = String(res.content[0].text);
        expect(text).not.toMatch(/^Session:/);
    });

    it('surfaces paused per-session in parallel mode', async () => {
        const { registered } = build();
        const res = await registered
            .get('jules_run_task')!
            .handler({ ...args, parallel: 2 });
        const parsed = JSON.parse(String(res.content[0].text));
        expect(parsed.sessions).toHaveLength(2);
        // Assert the OUTCOME field, not just that the word "paused" appears —
        // the buggy timeout note reads "Timed out while still PAUSED", which
        // would satisfy a naive /paused/i match.
        for (const s of parsed.sessions) {
            expect(s.outcome).toBe('paused');
            expect(s.note).not.toMatch(/timed out/i);
        }
    });
});
