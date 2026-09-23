/**
 * MCP progress notifications + client cancellation for jules_run_task (#50418).
 *
 * DESIGN.md's resolved decision #2 already claimed we report progress through
 * MCP progress notifications. We did not — there were zero `progressToken` /
 * `sendNotification` references in convenience.ts. These tests make the claim
 * true and pin the two failure modes that matter: emitting nothing when the
 * client did not ask (no crash, no spam), and stopping promptly on abort.
 */
import { describe, it, expect, vi } from 'vitest';
import { registerConvenienceTools } from '../src/tools/convenience.js';
import type { JulesClient } from '../src/jules-client.js';
import type { Session } from '../src/types.js';

vi.mock('../src/audit.js', () => ({
    emitAudit: vi.fn().mockResolvedValue(undefined),
}));

const makeSession = (state: string): Session =>
    ({
        name: 'sessions/1',
        id: '1',
        prompt: 'p',
        sourceContext: { source: 's' },
        state,
        createTime: '',
        updateTime: '',
        url: 'https://jules/1',
    }) as Session;

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

function register(client: Partial<JulesClient>) {
    const made = makeServer();
    registerConvenienceTools(made.server, client as JulesClient);
    return made.tools;
}

const args = {
    prompt: 'do the thing',
    source: 'sources/github/o/r',
    starting_branch: 'main',
    reason: 'test',
    poll_interval_ms: 1,
    timeout_ms: 50,
};

describe('jules_run_task progress notifications', () => {
    it('emits notifications/progress when the client supplies a progressToken', async () => {
        const sent: any[] = [];
        const extra = {
            _meta: { progressToken: 'tok-1' },
            sendNotification: vi.fn(async (n: any) => {
                sent.push(n);
            }),
        };
        const client: Partial<JulesClient> = {
            createSession: vi.fn().mockResolvedValue(makeSession('QUEUED')),
            getSession: vi
                .fn()
                .mockResolvedValueOnce(makeSession('IN_PROGRESS'))
                .mockResolvedValue(makeSession('COMPLETED')),
            approvePlan: vi.fn(),
        };

        const tools = register(client);
        await tools.get('jules_run_task')!.handler({ ...args }, extra);

        expect(extra.sendNotification).toHaveBeenCalled();
        const first = sent[0];
        expect(first.method).toBe('notifications/progress');
        expect(first.params.progressToken).toBe('tok-1');
        // Meaningful progress/total: elapsed and the timeout budget.
        expect(typeof first.params.progress).toBe('number');
        expect(typeof first.params.total).toBe('number');
        expect(first.params.total).toBeGreaterThanOrEqual(0);
        // ...plus the current session state, so the message is not just a clock.
        expect(first.params.message).toContain('QUEUED');
    });

    it('degrades silently when no progressToken is supplied', async () => {
        const extra = { sendNotification: vi.fn() };
        const client: Partial<JulesClient> = {
            createSession: vi.fn().mockResolvedValue(makeSession('QUEUED')),
            getSession: vi.fn().mockResolvedValue(makeSession('COMPLETED')),
            approvePlan: vi.fn(),
        };

        const tools = register(client);
        const result = await tools
            .get('jules_run_task')!
            .handler({ ...args }, extra);

        expect(extra.sendNotification).not.toHaveBeenCalled();
        expect(result.content[0].text).toContain('COMPLETED');
    });

    it('does not crash when extra is absent entirely', async () => {
        const client: Partial<JulesClient> = {
            createSession: vi.fn().mockResolvedValue(makeSession('QUEUED')),
            getSession: vi.fn().mockResolvedValue(makeSession('COMPLETED')),
            approvePlan: vi.fn(),
        };
        const tools = register(client);
        const result = await tools.get('jules_run_task')!.handler({ ...args });
        expect(result.content[0].text).toContain('COMPLETED');
    });

    it('a sendNotification that rejects cannot fail the run it reports on', async () => {
        const extra = {
            _meta: { progressToken: 'tok-1' },
            sendNotification: vi.fn(async () => {
                throw new Error('transport gone');
            }),
        };
        const client: Partial<JulesClient> = {
            createSession: vi.fn().mockResolvedValue(makeSession('QUEUED')),
            getSession: vi.fn().mockResolvedValue(makeSession('COMPLETED')),
            approvePlan: vi.fn(),
        };
        const tools = register(client);
        const result = await tools
            .get('jules_run_task')!
            .handler({ ...args }, extra);
        expect(result.content[0].text).toContain('COMPLETED');
    });
});

describe('jules_run_task cancellation', () => {
    it('stops promptly when the client signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const extra = { signal: controller.signal };
        const client: Partial<JulesClient> = {
            createSession: vi.fn().mockResolvedValue(makeSession('QUEUED')),
            // Would poll forever if the abort were ignored.
            getSession: vi.fn().mockResolvedValue(makeSession('IN_PROGRESS')),
            approvePlan: vi.fn(),
        };

        const tools = register(client);
        const result = await tools
            .get('jules_run_task')!
            .handler({ ...args }, extra);

        const text = result.content[0].text;
        expect(text).toContain('cancelled');
        // The session must NOT be reported as a timeout or as a success.
        expect(text).not.toContain('Timed out');
        // And it did not keep polling: create, then at most the first check.
        expect(
            (client.getSession as any).mock.calls.length,
        ).toBeLessThanOrEqual(1);
    });
});
