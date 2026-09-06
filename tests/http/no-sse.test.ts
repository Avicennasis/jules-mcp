/**
 * The GET-405 claim, verified against the pinned SDK rather than quoted
 * (Redmine #50638).
 *
 * The ticket asserts that returning 405 for `GET /mcp` is spec-legal and that
 * the official `@modelcontextprotocol/sdk` client falls back to POST-only, so
 * no SSE implementation is needed. Both halves are checked here against the
 * version this repo actually resolves, not against a remembered one:
 *
 *   - Spec 2025-06-18, "Listening for Messages from the Server", item 3: "The
 *     server MUST either return `Content-Type: text/event-stream` in response
 *     to this HTTP GET, or else return HTTP 405 Method Not Allowed, indicating
 *     that the server does not offer an SSE stream at this endpoint."
 *   - SDK client: `dist/esm/client/streamableHttp.js` handles `if
 *     (response.status === 405) { return; }` in `_startOrAuthSse`, and the GET
 *     is only attempted after `notifications/initialized` is accepted, with
 *     failures routed to `onerror` rather than thrown.
 *
 * ONE CORRECTION TO THE TICKET, and it is the reason this test drives a real
 * client: the SDK's *server* transport does NOT return 405 for GET. Its
 * `handleGetRequest` opens an SSE stream. The 405 has to be produced by our
 * own handler ahead of it, which is exactly what src/http/handler.ts does.
 *
 * No socket is opened. The SDK client transport accepts a `fetch` override, so
 * the real client speaks to our real handler through an in-process shim.
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRequestHandler } from '../../src/http/handler.js';
import type { HttpTransportConfig } from '../../src/http/config.js';

const TOKEN = 'a'.repeat(32);
const SESSION_ID = 'sess-under-test';

const config: HttpTransportConfig = {
    host: '127.0.0.1',
    port: 9673,
    path: '/mcp',
    token: TOKEN,
    allowedOrigins: [],
    maxBodyBytes: 1024 * 1024,
    bindsBeyondLoopback: false,
};

/**
 * A minimal MCP core standing in for the SDK server transport: it answers
 * `initialize` with a session id, notifications with 202, and `tools/list`
 * with a JSON result. Enough to exercise the client's transport state machine.
 */
const dispatch = vi.fn(
    async (
        _req: IncomingMessage,
        res: ServerResponse,
        ctx: { body?: unknown },
    ) => {
        const message = ctx.body as { id?: number; method?: string };
        if (message?.id === undefined) {
            res.writeHead(202, { 'Content-Length': '0' });
            res.end();
            return;
        }
        const result =
            message.method === 'initialize'
                ? {
                      protocolVersion: '2025-06-18',
                      capabilities: {},
                      serverInfo: { name: 'jules-mcp', version: '0.0.0' },
                  }
                : { tools: [] };
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result,
        });
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            'mcp-session-id': SESSION_ID,
        });
        res.end(body);
    },
);

interface Seen {
    method: string;
    status: number;
}

/** Drive our real handler from a Web `fetch` call, with no socket in between. */
function makeFetchShim(seen: Seen[]) {
    const handler = createRequestHandler({ config, dispatch, log: vi.fn() });

    return async function shim(
        input: string | URL | Request,
        init?: RequestInit,
    ): Promise<Response> {
        const url = new URL(
            String(input instanceof Request ? input.url : input),
        );
        const method = init?.method ?? 'GET';

        const headers: Record<string, string> = {};
        new Headers(init?.headers as HeadersInit | undefined).forEach(
            (value, key) => {
                headers[key.toLowerCase()] = value;
            },
        );

        const bodyText = typeof init?.body === 'string' ? init.body : '';
        const req = Object.assign(
            Readable.from(bodyText === '' ? [] : [Buffer.from(bodyText)]),
            { method, url: url.pathname + url.search, headers },
        ) as unknown as IncomingMessage;

        let status = 0;
        const outHeaders: Record<string, string> = {};
        let out = '';
        const res = {
            headersSent: false,
            writeHead(code: number, hdrs?: Record<string, string>) {
                status = code;
                for (const [k, v] of Object.entries(hdrs ?? {})) {
                    outHeaders[k.toLowerCase()] = String(v);
                }
                (res as { headersSent: boolean }).headersSent = true;
                return res;
            },
            setHeader(name: string, value: string) {
                outHeaders[name.toLowerCase()] = String(value);
            },
            end(chunk?: string) {
                if (chunk) out += chunk;
                return res;
            },
        };

        await handler(req, res as unknown as ServerResponse);
        seen.push({ method, status });

        return new Response(status === 202 || status === 405 ? null : out, {
            status,
            headers: outHeaders,
        });
    };
}

describe('GET /mcp returns 405 and the official SDK client keeps going', () => {
    it('completes an initialize handshake, then tolerates the 405 GET', async () => {
        const seen: Seen[] = [];
        const onerror = vi.fn();

        const transport = new StreamableHTTPClientTransport(
            new URL('http://127.0.0.1:9673/mcp'),
            {
                fetch: makeFetchShim(seen) as unknown as typeof fetch,
                requestInit: {
                    headers: { Authorization: `Bearer ${TOKEN}` },
                },
            },
        );

        const responses: unknown[] = [];
        transport.onmessage = (message) => responses.push(message);
        transport.onerror = onerror;

        await transport.start();
        await transport.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'test', version: '0' },
            },
        });
        expect(transport.sessionId).toBe(SESSION_ID);

        // Accepting notifications/initialized is what makes the client attempt
        // the optional GET stream.
        await transport.send({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
        });

        // The GET is fired without await inside the SDK; wait for it to land.
        for (
            let i = 0;
            i < 50 && !seen.some((s) => s.method === 'GET');
            i += 1
        ) {
            await new Promise((resolve) => setImmediate(resolve));
        }

        const get = seen.find((s) => s.method === 'GET');
        expect(get).toBeDefined();
        expect(get?.status).toBe(405);

        // The whole point: 405 is not an error to this client.
        expect(onerror).not.toHaveBeenCalled();

        // ...and the session still works over POST alone.
        await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        expect(responses).toHaveLength(2);
        expect(
            seen
                .filter((s) => s.method === 'POST')
                .every((s) => s.status < 400),
        ).toBe(true);

        await transport.close();
    });

    it('does not let an unauthenticated client past the handler', async () => {
        const seen: Seen[] = [];
        dispatch.mockClear();

        const transport = new StreamableHTTPClientTransport(
            new URL('http://127.0.0.1:9673/mcp'),
            { fetch: makeFetchShim(seen) as unknown as typeof fetch },
        );
        transport.onerror = vi.fn();

        await transport.start();
        await expect(
            transport.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'test', version: '0' },
                },
            }),
        ).rejects.toThrow();

        expect(seen[0].status).toBe(401);
        expect(dispatch).not.toHaveBeenCalled();
        await transport.close();
    });
});
