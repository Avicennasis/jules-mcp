/**
 * #50646, the load-bearing half: a dispatch-log write failure must NOT fail or
 * block the dispatch. The sessions are already running on Jules — that is the
 * work that matters — so the only correct outcome is a successful result plus a
 * warning the reader cannot miss.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerConvenienceTools } from '../../src/tools/convenience.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { Session } from '../../src/types.js';

vi.mock('../../src/audit.js', () => ({
    emitAudit: vi.fn().mockResolvedValue(undefined),
}));

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convenience-dispatch-'));
});

afterEach(() => {
    delete process.env.JULES_DISPATCH_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
});

function harness() {
    const tools = new Map<string, { handler: Function }>();
    const server: any = {
        tool: vi.fn((name: string, _d: string, _s: any, handler: Function) =>
            void tools.set(name, { handler }),
        ),
    };
    const make = (state: string): Session =>
        ({
            name: 'sessions/abc123',
            id: 'abc123',
            prompt: 'p',
            sourceContext: { source: 's' },
            state,
            createTime: '2026-09-24T00:00:00Z',
            updateTime: '',
            url: 'https://jules/abc123',
        }) as Session;

    let n = 0;
    const client: Partial<JulesClient> = {
        createSession: vi.fn().mockResolvedValue(make('QUEUED')),
        getSession: vi.fn().mockImplementation(async () => {
            n++;
            return make(n >= 1 ? 'COMPLETED' : 'QUEUED');
        }),
        approvePlan: vi.fn().mockResolvedValue(make('IN_PROGRESS')),
    };
    registerConvenienceTools(server, client as JulesClient);
    return tools;
}

const runTask = (tools: Map<string, { handler: Function }>) =>
    tools.get('jules_run_task')!.handler({
        prompt: 'fix it',
        source: 'sources/github/o/r',
        starting_branch: 'main',
        reason: 'because',
        auto_approve: true,
        poll_interval_ms: 5,
        timeout_ms: 5000,
    });

describe('run_task dispatch log (#50646)', () => {
    it('records the dispatch on success, with no warning', async () => {
        process.env.JULES_DISPATCH_LOG = path.join(dir, 'dispatches.jsonl');
        const res = await runTask(harness());

        expect(res.content[0].text).toContain('COMPLETED');
        expect(res.content[0].text).not.toContain('FAILED');

        const lines = fs
            .readFileSync(process.env.JULES_DISPATCH_LOG, 'utf8')
            .trim()
            .split('\n');
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]);
        expect(entry.mode).toBe('run_task');
        expect(entry.source).toBe('sources/github/o/r');
        expect(entry.branch).toBe('main');
        expect(entry.sessions[0]).toMatchObject({
            id: 'abc123',
            url: 'https://jules/abc123',
        });
    });

    it('a write failure still returns SUCCESS, with a warning naming the id', async () => {
        // Parent of the log path is a FILE, so it cannot be created (ENOTDIR).
        const asFile = path.join(dir, 'not-a-dir');
        fs.writeFileSync(asFile, 'x');
        process.env.JULES_DISPATCH_LOG = path.join(
            asFile,
            'sub',
            'dispatches.jsonl',
        );

        const res = await runTask(harness());

        // The work succeeded and must be reported as such.
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain('COMPLETED');
        // ...but the reader must not assume the id is recoverable.
        expect(res.content[0].text).toContain('dispatch log write FAILED');
        expect(res.content[0].text).toContain('abc123');
    });
});
