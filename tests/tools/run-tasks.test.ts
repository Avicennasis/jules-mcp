/**
 * jules_run_tasks — one session per entry in a task LIST (Redmine #50655).
 *
 * The distinction this file exists to protect: `jules_run_task`'s `parallel`
 * repeats ONE prompt N times; this tool takes N DIFFERENT prompts. The README
 * used to claim `parallel` covered the task-list case, which was wrong, so the
 * first test asserts the prompts actually differ rather than merely counting
 * createSession calls.
 *
 * Enforcement is driven through the HANDLER, not a policy function (#50461): a
 * predicate that is written, unit-tested and never wired in is a green suite
 * over a dead code path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerConvenienceTools } from '../../src/tools/convenience.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { Session } from '../../src/types.js';

vi.mock('../../src/audit.js', () => ({
    emitAudit: vi.fn().mockResolvedValue(undefined),
}));

const makeSession = (id: string, state = 'QUEUED'): Session =>
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

/** Fake server capturing handlers by name, as the other tool suites do. */
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

describe('jules_run_tasks', () => {
    let tools: Map<string, { handler: Function }>;
    let mockClient: Partial<JulesClient>;

    beforeEach(() => {
        vi.resetAllMocks();
        const made = makeServer();
        tools = made.tools;
        mockClient = {
            createSession: vi
                .fn()
                .mockImplementation(async () =>
                    makeSession(`s${Math.random().toString(36).slice(2, 8)}`),
                ),
            getSession: vi
                .fn()
                .mockResolvedValue(makeSession('x', 'COMPLETED')),
            approvePlan: vi.fn().mockResolvedValue(makeSession('x')),
        };
        registerConvenienceTools(made.server, mockClient as JulesClient);
    });

    it('registers jules_run_tasks alongside jules_run_task', () => {
        expect(tools.has('jules_run_tasks')).toBe(true);
        expect(tools.has('jules_run_task')).toBe(true);
    });

    it('creates one session per entry, with DIFFERENT prompts', async () => {
        const calls = (mockClient.createSession as any).mock.calls;
        const result = await tools.get('jules_run_tasks')!.handler({
            tasks: [
                { prompt: 'fix the parser' },
                { prompt: 'add the tests' },
                { prompt: 'write the changelog' },
            ],
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'batch',
            poll_interval_ms: 5,
            timeout_ms: 2000,
        });

        expect(mockClient.createSession).toHaveBeenCalledTimes(3);
        const prompts = calls.map((c: any[]) => c[0].prompt);
        // The whole point: three DISTINCT prompts, not one prompt three times.
        expect(new Set(prompts).size).toBe(3);
        expect(prompts).toEqual([
            'fix the parser',
            'add the tests',
            'write the changelog',
        ]);
        expect(result.content[0].text).toContain('"status": "OK"');
    });

    it('defaults source/starting_branch from the shared args, per-entry overridable', async () => {
        await tools.get('jules_run_tasks')!.handler({
            tasks: [
                { prompt: 'a' },
                { prompt: 'b', source: 'sources/github/other/repo' },
                { prompt: 'c', starting_branch: 'release' },
                { prompt: 'd', title: 'custom title' },
            ],
            source: 'sources/github/o/r',
            starting_branch: 'main',
            automation_mode: 'AUTO_CREATE_PR',
            reason: 'batch',
            poll_interval_ms: 5,
            timeout_ms: 2000,
        });

        const bodies = (mockClient.createSession as any).mock.calls.map(
            (c: any[]) => c[0],
        );
        expect(bodies[0].sourceContext.source).toBe('sources/github/o/r');
        expect(bodies[0].sourceContext.githubRepoContext.startingBranch).toBe(
            'main',
        );
        expect(bodies[1].sourceContext.source).toBe(
            'sources/github/other/repo',
        );
        expect(bodies[2].sourceContext.githubRepoContext.startingBranch).toBe(
            'release',
        );
        expect(bodies[3].title).toBe('custom title');
        // Shared automation_mode reaches entries that do not override it.
        expect(bodies[0].automationMode).toBe('AUTO_CREATE_PR');
    });

    it('isolates a creation failure and reports it without losing the rest', async () => {
        let n = 0;
        (mockClient.createSession as any).mockImplementation(async () => {
            n++;
            if (n === 2) throw new Error('quota exploded');
            return makeSession(`ok${n}`);
        });

        const result = await tools.get('jules_run_tasks')!.handler({
            tasks: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }],
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'batch',
            poll_interval_ms: 5,
            timeout_ms: 2000,
        });

        const body = JSON.parse(result.content[0].text);
        expect(body.status).toBe('PARTIAL');
        expect(body.failed).toHaveLength(1);
        expect(body.failed[0].error).toContain('quota exploded');
        // The two survivors still ran to completion.
        expect(body.sessions).toHaveLength(2);
        expect(mockClient.getSession).toHaveBeenCalledTimes(2);
    });

    it('handles a single entry', async () => {
        const result = await tools.get('jules_run_tasks')!.handler({
            tasks: [{ prompt: 'only one' }],
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'batch',
            poll_interval_ms: 5,
            timeout_ms: 2000,
        });
        expect(mockClient.createSession).toHaveBeenCalledTimes(1);
        expect(result.content[0].text).toContain('"status": "OK"');
    });

    it('refuses an empty list rather than reporting a zero-session success', async () => {
        // The schema has .min(1); this drives the handler directly, because a
        // caller bypassing zod parsing must not get a clean run out of nothing.
        const result = await tools.get('jules_run_tasks')!.handler({
            tasks: [],
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'batch',
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('at least one entry');
        expect(mockClient.createSession).not.toHaveBeenCalled();
    });

    it('never exceeds the concurrency bound on a list longer than it', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        (mockClient.createSession as any).mockImplementation(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 2));
            inFlight--;
            return makeSession(`s${Math.random().toString(36).slice(2, 8)}`);
        });

        const tasks = Array.from({ length: 12 }, (_, i) => ({
            prompt: `task ${i}`,
        }));
        const result = await tools.get('jules_run_tasks')!.handler({
            tasks,
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'batch',
            concurrency: 3,
            poll_interval_ms: 5,
            timeout_ms: 5000,
        });

        expect(mockClient.createSession).toHaveBeenCalledTimes(12);
        expect(maxInFlight).toBeLessThanOrEqual(3);
        expect(result.content[0].text).toContain('"status": "OK"');
    });

    it('dry_run renders every would-be request and creates nothing', async () => {
        const result = await tools.get('jules_run_tasks')!.handler({
            tasks: [{ prompt: 'a' }, { prompt: 'b' }],
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'batch',
            dry_run: true,
        });

        const body = JSON.parse(result.content[0].text);
        expect(body.status).toBe('DRY_RUN');
        expect(body.count).toBe(2);
        expect(body.would_request).toHaveLength(2);
        expect(body.would_request[0].method).toBe('POST');
        expect(body.would_request[0].url).toBe('/v1alpha/sessions');
        expect(body.would_request[1].body.prompt).toBe('b');
        expect(mockClient.createSession).not.toHaveBeenCalled();
    });

    it('refuses the WHOLE call when any entry targets a denied repo, even under dry_run', async () => {
        process.env.JULES_ALLOWED_REPOS = 'avic/*';
        const made = makeServer();
        registerConvenienceTools(made.server, mockClient as JulesClient);
        try {
            const result = await made.tools.get('jules_run_tasks')!.handler({
                tasks: [
                    { prompt: 'fine', source: 'sources/github/avic/ok' },
                    { prompt: 'denied', source: 'sources/github/evil/nope' },
                ],
                source: 'sources/github/avic/ok',
                starting_branch: 'main',
                reason: 'batch',
                dry_run: true,
            });
            expect(result.isError).toBe(true);
            expect(mockClient.createSession).not.toHaveBeenCalled();
        } finally {
            delete process.env.JULES_ALLOWED_REPOS;
        }
    });
});
