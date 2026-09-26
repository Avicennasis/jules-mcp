import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerDispatchTools } from '../../src/tools/dispatch.js';
import { buildDispatchEntry, recordDispatch } from '../../src/dispatch-log.js';
import type { Session } from '../../src/types.js';
import type { JulesClient } from '../../src/jules-client.js';

const session = (id: string): Session =>
    ({
        name: `sessions/${id}`,
        id,
        prompt: 'p',
        title: `t ${id}`,
        createTime: '2026-09-24T00:00:00Z',
        updateTime: '2026-09-24T00:00:00Z',
        state: 'IN_PROGRESS',
        url: `https://jules.google/${id}`,
    }) as Session;

let dir: string;
let log: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-tool-'));
    log = path.join(dir, 'dispatches.jsonl');
    process.env.JULES_DISPATCH_LOG = log;
});

afterEach(() => {
    delete process.env.JULES_DISPATCH_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
});

function harness(clientOver: Partial<JulesClient> = {}) {
    const tools = new Map<string, { handler: Function }>();
    const server: any = {
        tool: vi.fn(
            (name: string, _d: string, _s: any, handler: Function) =>
                void tools.set(name, { handler }),
        ),
    };
    const client = {
        getSession: vi.fn(),
        ...clientOver,
    } as unknown as JulesClient;
    registerDispatchTools(server, client);
    return { tools, client };
}

describe('jules_list_dispatches', () => {
    it('registers the tool', () => {
        const { tools } = harness();
        expect(tools.has('jules_list_dispatches')).toBe(true);
    });

    it('returns recorded batches newest-first, honoring limit', async () => {
        for (const id of ['b1', 'b2', 'b3']) {
            recordDispatch(
                buildDispatchEntry({
                    mode: 'run_task',
                    source: 's',
                    branch: 'main',
                    reason: 'r',
                    prompt: 'p',
                    parallel: 1,
                    sessions: [session(id)],
                }),
                log,
            );
        }
        const { tools } = harness();
        const handler = tools.get('jules_list_dispatches')!.handler;
        const res = await handler({ limit: 2, check_status: false });
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.status).toBe('OK');
        expect(parsed.total_batches).toBe(3);
        expect(parsed.returned).toBe(2);
        // newest first: b3 then b2
        expect(parsed.dispatches.map((d: any) => d.sessions[0].id)).toEqual([
            'b3',
            'b2',
        ]);
    });

    it('filters by batch_id', async () => {
        const e1 = buildDispatchEntry({
            mode: 'run_task',
            source: 's',
            branch: 'main',
            reason: 'r',
            prompt: 'p',
            parallel: 1,
            sessions: [session('a')],
        });
        recordDispatch(e1, log);
        recordDispatch(
            buildDispatchEntry({
                mode: 'run_task',
                source: 's',
                branch: 'main',
                reason: 'r',
                prompt: 'p',
                parallel: 1,
                sessions: [session('b')],
            }),
            log,
        );

        const { tools } = harness();
        const handler = tools.get('jules_list_dispatches')!.handler;
        const res = await handler({
            limit: 10,
            batch_id: e1.batchId,
            check_status: false,
        });
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.returned).toBe(1);
        expect(parsed.dispatches[0].sessions[0].id).toBe('a');
    });

    it('check_status re-reads each session and reports its CURRENT state', async () => {
        recordDispatch(
            buildDispatchEntry({
                mode: 'run_task',
                source: 's',
                branch: 'main',
                reason: 'r',
                prompt: 'p',
                parallel: 1,
                sessions: [session('a')],
            }),
            log,
        );
        const getSession = vi.fn().mockResolvedValue(session('a'));
        getSession.mockResolvedValue({ ...session('a'), state: 'COMPLETED' });
        const { tools } = harness({ getSession: getSession as any });
        const handler = tools.get('jules_list_dispatches')!.handler;
        const res = await handler({ limit: 10, check_status: true });
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.dispatches[0].sessions[0].state).toBe('COMPLETED');
        expect(getSession).toHaveBeenCalledWith('a');
    });

    it('a failed status check keeps the recorded state and says so', async () => {
        recordDispatch(
            buildDispatchEntry({
                mode: 'run_task',
                source: 's',
                branch: 'main',
                reason: 'r',
                prompt: 'p',
                parallel: 1,
                sessions: [session('a')],
            }),
            log,
        );
        const getSession = vi.fn().mockRejectedValue(new Error('404 gone'));
        const { tools } = harness({ getSession: getSession as any });
        const handler = tools.get('jules_list_dispatches')!.handler;
        const res = await handler({ limit: 10, check_status: true });
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.dispatches[0].sessions[0].state).toContain('IN_PROGRESS');
        expect(parsed.dispatches[0].sessions[0].state).toContain('404 gone');
    });

    it('an empty log is OK, not an error', async () => {
        const { tools } = harness();
        const handler = tools.get('jules_list_dispatches')!.handler;
        const res = await handler({ limit: 10, check_status: false });
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.status).toBe('OK');
        expect(parsed.returned).toBe(0);
    });
});
