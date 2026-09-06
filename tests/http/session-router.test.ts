/**
 * Session routing for the streamable-HTTP transport (Redmine #50638).
 *
 * The reference implementation's session handling was decorative: a uuid was
 * minted on `initialize`, never stored, never validated, and DELETE returned
 * 200 unconditionally. #50652 is the same failure one step further on -- a
 * middleware added to be lenient about expired session ids that skipped
 * session validation altogether.
 *
 * So the assertions here are about what the router REFUSES: an unknown session
 * id is a 404 and must not quietly mint a replacement, and a non-initialize
 * request with no session id is a 400 rather than an implicit new session.
 *
 * Concurrency is asserted directly rather than assumed. The Python reference
 * used a single-threaded `HTTPServer`, which serializes every request; a
 * `jules_run_task` poll would block every other client for minutes.
 */
import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    McpSessionRouter,
    type HttpMcpTransport,
    type SessionHooks,
} from '../../src/http/server.js';

function fakeRequest(
    method: string,
    headers: Record<string, string> = {},
): IncomingMessage {
    return { method, url: '/mcp', headers } as unknown as IncomingMessage;
}

function fakeResponse() {
    const recorded = { status: 0, body: '', ended: false };
    const res = {
        headersSent: false,
        writeHead(status: number) {
            recorded.status = status;
            (res as { headersSent: boolean }).headersSent = true;
            return res;
        },
        setHeader() {},
        end(chunk?: string) {
            if (chunk) recorded.body += chunk;
            recorded.ended = true;
            return res;
        },
    };
    return { res: res as unknown as ServerResponse, recorded };
}

const initializeBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
    },
};

/** A transport stand-in that announces a session id when first used. */
function fakeTransportFactory(
    sessionId: string,
    handle?: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
) {
    const closed = { value: false };
    const create = vi.fn(async (hooks: SessionHooks) => {
        const transport: HttpMcpTransport = {
            sessionId,
            async handleRequest(req, res) {
                hooks.onInitialized(sessionId);
                if (handle) return handle(req, res);
                res.writeHead(200);
                res.end('{}');
            },
            async close() {
                closed.value = true;
                hooks.onClosed(sessionId);
            },
        };
        return transport;
    });
    return { create, closed };
}

describe('McpSessionRouter — creating a session', () => {
    it('creates one on an initialize POST with no session id', async () => {
        const { create } = fakeTransportFactory('sess-1');
        const router = new McpSessionRouter({ createSession: create });
        const { res } = fakeResponse();
        await router.dispatch(fakeRequest('POST'), res, {
            principal: 'bearer',
            body: initializeBody,
        });
        expect(create).toHaveBeenCalledTimes(1);
        expect(router.sessionCount).toBe(1);
    });

    it('400s a non-initialize POST with no session id', async () => {
        const { create } = fakeTransportFactory('sess-1');
        const router = new McpSessionRouter({ createSession: create });
        const { res, recorded } = fakeResponse();
        await router.dispatch(fakeRequest('POST'), res, {
            principal: 'bearer',
            body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        });
        expect(recorded.status).toBe(400);
        expect(create).not.toHaveBeenCalled();
        expect(router.sessionCount).toBe(0);
    });

    it('400s a DELETE with no session id rather than answering 200', async () => {
        // The reference returned 200 for every DELETE, so a client could never
        // tell a real teardown from a no-op.
        const { create } = fakeTransportFactory('sess-1');
        const router = new McpSessionRouter({ createSession: create });
        const { res, recorded } = fakeResponse();
        await router.dispatch(fakeRequest('DELETE'), res, {
            principal: 'bearer',
        });
        expect(recorded.status).toBe(400);
        expect(create).not.toHaveBeenCalled();
    });
});

describe('McpSessionRouter — validating a session', () => {
    it('routes a known session id to its transport', async () => {
        const handle = vi.fn(async (_req, res: ServerResponse) => {
            res.writeHead(200);
            res.end('{"ok":true}');
        });
        const { create } = fakeTransportFactory('sess-1', handle);
        const router = new McpSessionRouter({ createSession: create });

        const first = fakeResponse();
        await router.dispatch(fakeRequest('POST'), first.res, {
            principal: 'bearer',
            body: initializeBody,
        });

        const second = fakeResponse();
        await router.dispatch(
            fakeRequest('POST', { 'mcp-session-id': 'sess-1' }),
            second.res,
            {
                principal: 'bearer',
                body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            },
        );
        expect(handle).toHaveBeenCalledTimes(2);
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('404s an unknown session id and does not mint a replacement', async () => {
        const { create } = fakeTransportFactory('sess-1');
        const router = new McpSessionRouter({ createSession: create });
        const { res, recorded } = fakeResponse();
        await router.dispatch(
            fakeRequest('POST', { 'mcp-session-id': 'not-a-session' }),
            res,
            { principal: 'bearer', body: initializeBody },
        );
        expect(recorded.status).toBe(404);
        expect(create).not.toHaveBeenCalled();
        expect(router.sessionCount).toBe(0);
    });

    it('404s an unknown session id even on an initialize body', async () => {
        // A client that presents a stale id must be told to start over, not
        // silently upgraded into a fresh authenticated session.
        const { create } = fakeTransportFactory('sess-1');
        const router = new McpSessionRouter({ createSession: create });
        const { res, recorded } = fakeResponse();
        await router.dispatch(
            fakeRequest('POST', { 'mcp-session-id': 'stale' }),
            res,
            { principal: 'bearer', body: initializeBody },
        );
        expect(recorded.status).toBe(404);
        expect(create).not.toHaveBeenCalled();
    });

    it('forgets a session once its transport closes', async () => {
        const { create } = fakeTransportFactory('sess-1');
        const router = new McpSessionRouter({ createSession: create });
        const { res } = fakeResponse();
        await router.dispatch(fakeRequest('POST'), res, {
            principal: 'bearer',
            body: initializeBody,
        });
        expect(router.sessionCount).toBe(1);
        await router.closeAll();
        expect(router.sessionCount).toBe(0);
    });
});

describe('McpSessionRouter — concurrency', () => {
    it('serves a second session while the first is still in flight', async () => {
        let releaseFirst: (() => void) | undefined;
        const firstInFlight = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        let created = 0;
        const create = vi.fn(async (hooks: SessionHooks) => {
            created += 1;
            const id = `sess-${created}`;
            const slow = id === 'sess-1';
            const transport: HttpMcpTransport = {
                sessionId: id,
                async handleRequest(_req, res) {
                    hooks.onInitialized(id);
                    if (slow) await firstInFlight;
                    res.writeHead(200);
                    res.end('{}');
                },
                async close() {
                    hooks.onClosed(id);
                },
            };
            return transport;
        });

        const router = new McpSessionRouter({ createSession: create });
        const slow = fakeResponse();
        const fast = fakeResponse();

        const slowPromise = router.dispatch(fakeRequest('POST'), slow.res, {
            principal: 'bearer',
            body: initializeBody,
        });
        await router.dispatch(fakeRequest('POST'), fast.res, {
            principal: 'bearer',
            body: initializeBody,
        });

        expect(fast.recorded.ended).toBe(true);
        expect(slow.recorded.ended).toBe(false);

        releaseFirst?.();
        await slowPromise;
        expect(slow.recorded.ended).toBe(true);
    });
});
