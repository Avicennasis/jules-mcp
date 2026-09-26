import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from './types.js';

/**
 * A local record of dispatched sessions (#50646).
 *
 * When `jules_run_task(parallel: 10)` returns, the session IDs exist only in the
 * model's context. If the context is compacted, the session errors, or the user
 * closes the client, ten live Jules sessions are running against real repos with
 * no local record of what they are — and a Jules session outlives the MCP client
 * by design, so the record has to outlive the conversation too.
 *
 * WHY A SECOND SINK, not the audit log. `emitAudit` already records a `POST` per
 * created session, but its PRIMARY sink on this host is `inkwell-emit` (present
 * at /usr/local/bin/inkwell-emit), and the local `audit.jsonl` fallback is only
 * written when inkwell is absent. So the audit is not reliably locally readable,
 * which is exactly what recovery-from-context-loss needs. Adding the url/branch
 * to the audit payload would not fix that. Hence a local JSONL with its own
 * reader and a tool over it.
 *
 * The write is TOLERANT by construction (see recordDispatch): a bookkeeping
 * problem must never fail or block work that has already happened on Jules. That
 * is the same rule `emitAudit` follows.
 */

export interface DispatchSession {
    id: string;
    url: string;
    state: string;
    createTime: string;
    title?: string;
}

export interface DispatchEntry {
    batchId: string;
    dispatchedAt: string;
    mode: 'run_task' | 'run_task_parallel';
    source: string;
    branch: string;
    reason: string;
    prompt: string;
    parallel: number;
    sessions: DispatchSession[];
}

export interface DispatchWriteResult {
    ok: boolean;
    path: string;
    /** Present only when `ok` is false. */
    error?: string;
}

const DEFAULT_LOG = path.join(
    os.homedir(),
    '.local',
    'share',
    'jules-mcp',
    'dispatches.jsonl',
);

/** The dispatch log path. `JULES_DISPATCH_LOG` overrides it (tests, or a
 * relocated data dir). Resolved per call, not at import, so an env set later in
 * a process is honored. */
export function dispatchLogPath(): string {
    return process.env.JULES_DISPATCH_LOG || DEFAULT_LOG;
}

/** A collision-resistant batch id, so one run_task call is recoverable as a set. */
export function newBatchId(now: Date = new Date()): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `rt-${now.getTime().toString(36)}-${rand}`;
}

/** Project the API sessions into the fields the record keeps. */
export function toDispatchSessions(sessions: Session[]): DispatchSession[] {
    return sessions.map((s) => ({
        id: s.id,
        url: s.url,
        state: s.state,
        createTime: s.createTime,
        ...(s.title ? { title: s.title } : {}),
    }));
}

export function buildDispatchEntry(args: {
    mode: DispatchEntry['mode'];
    source: string;
    branch: string;
    reason: string;
    prompt: string;
    parallel: number;
    sessions: Session[];
    batchId?: string;
    now?: Date;
}): DispatchEntry {
    const now = args.now ?? new Date();
    return {
        batchId: args.batchId ?? newBatchId(now),
        dispatchedAt: now.toISOString(),
        mode: args.mode,
        source: args.source,
        branch: args.branch,
        reason: args.reason,
        prompt: args.prompt,
        parallel: args.parallel,
        sessions: toDispatchSessions(args.sessions),
    };
}

/**
 * Append one dispatch record. **Never throws and never rejects**: every failure
 * is returned as `{ok:false, error}` so the caller can surface it as a warning.
 */
export function recordDispatch(
    entry: DispatchEntry,
    logPath: string = dispatchLogPath(),
): DispatchWriteResult {
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        // 0600: the record carries prompts, which can be sensitive.
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', {
            mode: 0o600,
        });
        return { ok: true, path: logPath };
    } catch (error) {
        return {
            ok: false,
            path: logPath,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Read every dispatch record, oldest first. A missing log is an empty list; a
 * torn or unparseable line is skipped rather than failing the read. */
export function readDispatches(
    logPath: string = dispatchLogPath(),
): DispatchEntry[] {
    let raw: string;
    try {
        raw = fs.readFileSync(logPath, 'utf8');
    } catch {
        return [];
    }
    const out: DispatchEntry[] = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line) as DispatchEntry);
        } catch {
            // A crash mid-append can leave a partial final line; skip it.
        }
    }
    return out;
}
