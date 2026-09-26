import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    buildDispatchEntry,
    dispatchLogPath,
    newBatchId,
    readDispatches,
    recordDispatch,
} from '../src/dispatch-log.js';
import type { Session } from '../src/types.js';

const session = (id: string, over: Partial<Session> = {}): Session =>
    ({
        name: `sessions/${id}`,
        id,
        prompt: 'do the thing',
        title: `task ${id}`,
        sourceContext: { source: 'sources/github/o/r' },
        createTime: '2026-09-24T00:00:00Z',
        updateTime: '2026-09-24T00:00:00Z',
        state: 'IN_PROGRESS',
        url: `https://jules.google/${id}`,
        ...over,
    }) as Session;

let dir: string;
let log: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-log-'));
    log = path.join(dir, 'dispatches.jsonl');
    delete process.env.JULES_DISPATCH_LOG;
});

afterEach(() => {
    delete process.env.JULES_DISPATCH_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('dispatch log', () => {
    it('records a batch and reads it back with every recovery field', () => {
        const entry = buildDispatchEntry({
            mode: 'run_task_parallel',
            source: 'sources/github/o/r',
            branch: 'main',
            reason: 'batch of ten',
            prompt: 'do the thing',
            parallel: 2,
            sessions: [session('a'), session('b')],
        });
        expect(recordDispatch(entry, log)).toEqual({ ok: true, path: log });

        const read = readDispatches(log);
        expect(read).toHaveLength(1);
        const b = read[0];
        expect(b.batchId).toBe(entry.batchId);
        expect(b.mode).toBe('run_task_parallel');
        expect(b.source).toBe('sources/github/o/r');
        expect(b.branch).toBe('main');
        // The AC's fields, per session.
        expect(b.sessions).toEqual([
            {
                id: 'a',
                url: 'https://jules.google/a',
                state: 'IN_PROGRESS',
                createTime: '2026-09-24T00:00:00Z',
                title: 'task a',
            },
            {
                id: 'b',
                url: 'https://jules.google/b',
                state: 'IN_PROGRESS',
                createTime: '2026-09-24T00:00:00Z',
                title: 'task b',
            },
        ]);
    });

    it('keeps a batch recoverable as a SET (one entry, N sessions, one batchId)', () => {
        const entry = buildDispatchEntry({
            mode: 'run_task_parallel',
            source: 's',
            branch: 'main',
            reason: 'r',
            prompt: 'p',
            parallel: 3,
            sessions: [session('1'), session('2'), session('3')],
        });
        recordDispatch(entry, log);
        const [b] = readDispatches(log);
        expect(b.sessions.map((s) => s.id)).toEqual(['1', '2', '3']);
        expect(b.sessions.every(() => b.batchId.startsWith('rt-'))).toBe(true);
    });

    it('a write failure is RETURNED, never thrown — the dispatch must survive it', () => {
        // Parent is a FILE, so mkdirSync cannot create it (ENOTDIR).
        const asFile = path.join(dir, 'not-a-dir');
        fs.writeFileSync(asFile, 'x');
        const bad = path.join(asFile, 'sub', 'dispatches.jsonl');

        const result = recordDispatch(
            buildDispatchEntry({
                mode: 'run_task',
                source: 's',
                branch: 'main',
                reason: 'r',
                prompt: 'p',
                parallel: 1,
                sessions: [session('a')],
            }),
            bad,
        );
        expect(result.ok).toBe(false);
        expect(result.path).toBe(bad);
        expect(result.error).toBeTruthy();
    });

    it('omits a missing title rather than writing undefined', () => {
        const entry = buildDispatchEntry({
            mode: 'run_task',
            source: 's',
            branch: 'main',
            reason: 'r',
            prompt: 'p',
            parallel: 1,
            sessions: [session('a', { title: undefined })],
        });
        recordDispatch(entry, log);
        const [b] = readDispatches(log);
        expect('title' in b.sessions[0]).toBe(false);
        expect(JSON.parse(fs.readFileSync(log, 'utf8')).sessions[0].title).toBeUndefined();
    });

    it('a missing log reads as empty, and a torn line is skipped', () => {
        expect(readDispatches(path.join(dir, 'nope.jsonl'))).toEqual([]);

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
        // Simulate a crash mid-append.
        fs.appendFileSync(log, '{"batchId":"torn-half');
        const read = readDispatches(log);
        expect(read).toHaveLength(1);
        expect(read[0].sessions[0].id).toBe('a');
    });

    it('JULES_DISPATCH_LOG overrides the path, resolved per call', () => {
        delete process.env.JULES_DISPATCH_LOG;
        expect(dispatchLogPath()).toContain('jules-mcp');
        process.env.JULES_DISPATCH_LOG = log;
        expect(dispatchLogPath()).toBe(log);
    });

    it('chmods the log 0600 (it carries prompts)', () => {
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
        expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    });

    it('batch ids are unique across calls', () => {
        const ids = new Set(
            Array.from({ length: 200 }, () => newBatchId()),
        );
        expect(ids.size).toBe(200);
    });
});
