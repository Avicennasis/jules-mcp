/**
 * The HTTP shell in front of MCP dispatch (Redmine #50638).
 *
 * The assertion this file exists for is #50775's: *nothing* reaches dispatch
 * without authentication. Scarmonit/antigravity-jules-orchestration shipped a
 * public `POST /mcp/execute` with no inbound auth that forwarded request
 * bodies straight into the Jules API with the deployer's own key. Every
 * rejection case below therefore asserts BOTH the status code and that the
 * dispatch spy was never called — the status alone would not prove the Jules
 * call did not happen.
 *
 * No test here opens a socket. The handler is a plain
 * `(req, res) => Promise<void>` and is driven with stream-backed fakes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequestHandler } from '../../src/http/handler.js';
import type { HttpTransportConfig } from '../../src/http/config.js';

const TOKEN = 'a'.repeat(32);

const config: HttpTransportConfig = {
    host: '127.0.0.1',
    port: 9673,
    path: '/mcp',
    token: TOKEN,
    allowedOrigins: [],
    maxBodyBytes: 1024,
    bindsBeyondLoopback: false,
};

interface Recorded {
    status: number;
    headers: Record<string, string>;
    body: string;
    ended: boolean;
}

function fakeRequest(
    method: string,
    url: string,
    headers: Record<string, string | string[]> = {},
    body = '',
): IncomingMessage {
    const stream = Readable.from(body === '' ? [] : [Buffer.from(body)]);
    return Object.assign(stream, {
        method,
        url,
        headers,
    }) as unknown as IncomingMessage;
}

function fakeResponse(): { res: ServerResponse; recorded: Recorded } {
    const recorded: Recorded = {
        status: 0,
        headers: {},
        body: '',
        ended: false,
    };
    const res = {
        headersSent: false,
        writeHead(status: number, headers?: Record<string, string>) {
            recorded.status = status;
            Object.assign(recorded.headers, headers ?? {});
            (res as { headersSent: boolean }).headersSent = true;
            return res;
        },
        setHeader(name: string, value: string) {
            recorded.headers[name] = value;
        },
        end(chunk?: string) {
            if (chunk) recorded.body += chunk;
            recorded.ended = true;
            return res;
        },
    };
    return { res: res as unknown as ServerResponse, recorded };
}

const authed = { authorization: `Bearer ${TOKEN}` };

/** A minimal well-formed JSON-RPC request body. */
const initializeBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
});

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
    // Spying on process.stdout.write ALONE is not enough, and this was proven
    // by mutation: injecting a `console.log` into the handler left every
    // assertion green, because vitest intercepts the console before it reaches
    // process.stdout.write. Both sinks have to be watched for the claim
    // "nothing here writes to stdout" to mean anything.
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    consoleSpies = (['log', 'info', 'debug', 'dir'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => {}),
    );
});

afterEach(() => {
    stdoutSpy.mockRestore();
    for (const spy of consoleSpies) spy.mockRestore();
});

function makeHandler(overrides: Partial<HttpTransportConfig> = {}) {
    const dispatch = vi.fn(async () => {});
    const log = vi.fn();
    const handler = createRequestHandler({
        config: { ...config, ...overrides },
        dispatch,
        log,
    });
    return { handler, dispatch, log };
}

describe('createRequestHandler — routing', () => {
    it('404s any path other than the configured one, without dispatching', async () => {
        const { handler, dispatch } = makeHandler();
        const { res, recorded } = fakeResponse();
        await handler(
            fakeRequest('POST', '/mcp/execute', authed, initializeBody),
            res,
        );
        expect(recorded.status).toBe(404);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('matches the configured path ignoring the query string', async () => {
        const { handler, dispatch } = makeHandler();
        const { res } = fakeResponse();
        await handler(
            fakeRequest('POST', '/mcp?trace=1', authed, initializeBody),
            res,
        );
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
});

describe('createRequestHandler — authentication precedes dispatch', () => {
    it('rejects an unauthenticated POST with 401 and never dispatches', async () => {
        const { handler, dispatch } = makeHandler();
        const { res, recorded } = fakeResponse();
        await handler(fakeRequest('POST', '/mcp', {}, initializeBody), res);
        expect(recorded.status).toBe(401);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('advertises Bearer on a 401', async () => {
        const { handler } = makeHandler();
        const { res, recorded } = fakeResponse();
        await handler(fakeRequest('POST', '/mcp', {}, initializeBody), res);
        expect(recorded.headers['WWW-Authenticate']).toContain('Bearer');
    });

    it('rejects a wrong token with 401 and never dispatches', async () => {
        const { handler, dispatch } = makeHandler();
        const { res, recorded } = fakeResponse();
        await handler(
            fakeRequest(
                'POST',
                '/mcp',
                { authorization: `Bearer ${'z'.repeat(32)}` },
                initializeBody,
            ),
            res,
        );
        expect(recorded.status).toBe(401);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does not authenticate on a loopback-looking peer or forwarded-for', async () => {
        // #50662: socat re-originates, so 127.0.0.1 as the peer is not
        // evidence of anything. If a bind-address shortcut is ever
        // reintroduced, this flips to a pass and the guard is decoration.
        const { handler, dispatch } = makeHandler();
        const { res, recorded } = fakeResponse();
        await handler(
            fakeRequest(
                'POST',
                '/mcp',
                { 'x-forwarded-for': '127.0.0.1', host: '127.0.0.1:9673' },
                initializeBody,
            ),
            res,
        );
        expect(recorded.status).toBe(401);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('dispatches an authenticated POST with the parsed body and principal', async () => {
        const { handler, dispatch } = makeHandler();
        const { res } = fakeResponse();
        await handler(fakeRequest('POST', '/mcp', authed, initializeBody), res);
        expect(dispatch).toHaveBeenCalledTimes(1);
        const ctx = dispatch.mock.calls[0][2] as {
            principal: string;
            body: unknown;
        };
        expect(ctx.principal).toBe('bearer');
        expect(ctx.body).toEqual(JSON.parse(initializeBody));
    });
});

describe('createRequestHandler — Origin', () => {
    it('403s a request carrying an Origin when none are allowed', async () => {
        const { handler, dispatch } = makeHandler();
        const { res, recorded } = fakeResponse();
        await handler(
            fakeRequest(
                'POST',
                '/mcp',
                { ...authed, origin: 'https://evil.example' },
                initializeBody,
            ),
            res,
        );
        expect(recorded.status).toBe(403);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('echoes an allowlisted Origin exactly and never a wildcard', async () => {
        const { handler, dispatch } = makeHandler({
            allowedOrigins: ['http://localhost:3000'],
        });
        const { res, recorded } = fakeResponse();
        await handler(
            fakeRequest(
                'POST',
                '/mcp',
                { ...authed, origin: 'http://localhost:3000' },
                initializeBody,
            ),
            res,
        );
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(recorded.headers['Access-Control-Allow-Origin']).toBe(
            'http://localhost:3000',
        );
        expect(Object.values(recorded.headers).some((v) => v === '*')).toBe(
            false,
        );
    });

    it('answers a preflight for an allowed origin with 204 and no wildcard', async () => {
        const { handler, dispatch } = makeHandler({
            allowedOrigins: ['http://localhost:3000'],
        });
        const { res, recorded } = fakeResponse();
        await handler(
            fakeRequest('OPTIONS', '/mcp', {
                origin: 'http://localhost:3000',
            }),
            res,
        );
        expect(recorded.status).toBe(204);
        expect(recorded.headers['Access-Control-Allow-Origin']).toBe(
            'http://localhost:3000',
        );
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('403s a preflight from a disallowed origin', async () => {
        const { handler } = makeHandler({
            allowedOrigins: ['http://localhost:3000'],
        });
        const { res, recorded } = fakeResponse();
        await handler(
            fakeRequest('OPTIONS', '/mcp', { origin: 'https://evil.example' }),
            res,
        );
        expect(recorded.status).toBe(403);
    });
});

describe('createRequestHandler — methods', () => {
    it('answers GET with 405 and an Allow header (the deliberate no-SSE signal)', async () => {
        // Spec 2025-06-18, "Listening for Messages from the Server": the
        // server MUST either return text/event-stream or 405. We return 405,
        // and the official SDK client treats it as `return` rather than an
        // error, so the session continues POST-only.
        const { handler, dispatch } = makeHandler();
        const { res, recorded } = fakeResponse();
        await handler(
            fakeRequest('GET', '/mcp', {
                ...authed,
                accept: 'text/event-stream',
            }),
            res,
        );
        expect(recorded.status).toBe(405);
        expect(recorded.headers.Allow).toBe('POST, DELETE, OPTIONS');
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('still requires authentication on GET', async () => {
        const { handler } = makeHandler();
        const { res, recorded } = fakeResponse();
        await handler(
            fakeRequest('GET', '/mcp', { accept: 'text/event-stream' }),
            res,
        );
        expect(recorded.status).toBe(401);
    });

    it('dispatches DELETE with no body', async () => {
        const { handler, dispatch } = makeHandler();
        const { res } = fakeResponse();
        await handler(fakeRequest('DELETE', '/mcp', authed), res);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(
            (dispatch.mock.calls[0][2] as { body: unknown }).body,
        ).toBeUndefined();
    });

    it('405s an unsupported method', async () => {
        const { handler, dispatch } = makeHandler();
        const { res, recorded } = fakeResponse();
        await handler(fakeRequest('PUT', '/mcp', authed, '{}'), res);
        expect(recorded.status).toBe(405);
        expect(dispatch).not.toHaveBeenCalled();
    });
});

describe('createRequestHandler — request body', () => {
    it('413s a body over the cap without dispatching', async () => {
        const { handler, dispatch } = makeHandler({ maxBodyBytes: 16 });
        const { res, recorded } = fakeResponse();
        await handler(fakeRequest('POST', '/mcp', authed, 'x'.repeat(64)), res);
        expect(recorded.status).toBe(413);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('400s an unparseable body with a JSON-RPC parse error', async () => {
        const { handler, dispatch } = makeHandler();
        const { res, recorded } = fakeResponse();
        await handler(fakeRequest('POST', '/mcp', authed, '{nope'), res);
        expect(recorded.status).toBe(400);
        expect(JSON.parse(recorded.body).error.code).toBe(-32700);
        expect(dispatch).not.toHaveBeenCalled();
    });
});

describe('createRequestHandler — failure handling', () => {
    it('500s when dispatch throws, without leaking the message', async () => {
        const log = vi.fn();
        const handler = createRequestHandler({
            config,
            dispatch: async () => {
                throw new Error('JULES_API_KEY=secret leaked into an error');
            },
            log,
        });
        const { res, recorded } = fakeResponse();
        await handler(fakeRequest('POST', '/mcp', authed, initializeBody), res);
        expect(recorded.status).toBe(500);
        expect(recorded.body).not.toContain('JULES_API_KEY');
        expect(log).toHaveBeenCalled();
    });

    it('writes nothing to stdout, by either sink, on any path', async () => {
        // stdout is reserved for the MCP stdio transport; a stray console.log
        // corrupts the protocol for the other transport in the same binary.
        const { handler } = makeHandler({
            allowedOrigins: ['http://localhost:3000'],
        });
        const cases: Array<[string, Record<string, string>, string]> = [
            ['POST', {}, initializeBody],
            ['POST', authed, '{nope'],
            ['GET', authed, ''],
            ['PUT', authed, '{}'],
            ['OPTIONS', { origin: 'https://evil.example' }, ''],
        ];
        for (const [method, headers, body] of cases) {
            const { res } = fakeResponse();
            await handler(fakeRequest(method, '/mcp', headers, body), res);
        }
        expect(stdoutSpy).not.toHaveBeenCalled();
        for (const spy of consoleSpies) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it('keeps stdout-writing calls out of the HTTP sources entirely', async () => {
        // The runtime check above can only see the paths a test drives. This
        // one is static and sees every line, which is the half that catches a
        // console.log added to a branch nobody exercises.
        const { readFileSync, readdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = join(import.meta.dirname, '..', '..', 'src', 'http');
        const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            const source = readFileSync(join(dir, file), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '');
            expect(source).not.toMatch(/console\.(log|info|debug|dir)\s*\(/);
            expect(source).not.toMatch(/process\.stdout/);
        }
    });
});
