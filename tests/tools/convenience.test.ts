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
