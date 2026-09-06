/**
 * Session routing and process wiring for the streamable-HTTP transport
 * (Redmine #50638).
 *
 * `McpSessionRouter` owns the map of MCP session id -> live SDK transport.
 * `startHttpTransport` bolts it to a Node HTTP server behind the guards in
 * ./handler.ts.
 *
 * What this deliberately does NOT do:
 *
 *   - It does not accept an unknown session id. The spec says a server that
 *     has terminated a session MUST answer 404 for it, and the client MUST
 *     then re-initialize. The reference implementation in #50638 minted a uuid
 *     on `initialize`, never stored it and never checked it, which is the same
 *     as having no sessions at all; #50652 went further and added a fallback
 *     that skipped session validation for convenience.
 *   - It does not reimplement the Streamable HTTP protocol. POST and DELETE go
 *     to the SDK's own `StreamableHTTPServerTransport`, which handles the
 *     Accept-header rules, the 202-for-notifications rule, protocol-version
 *     negotiation and JSON-RPC framing. The one thing we take over is GET: the
 *     SDK's server transport happily opens an SSE stream there, and we do not
 *     want one, so ./handler.ts answers GET with 405 before dispatch is
 *     reached. That is the spec's stated alternative and the official client
 *     treats it as a clean "no stream available".
 *
 * Concurrency: Node's HTTP server is event-driven, and each session's requests
 * are awaited independently, so a long `jules_run_task` poll does not block
 * other clients. The Python reference used a single-threaded `HTTPServer`,
 * where it would have.
 */

import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpTransportConfig } from './config.js';
import {
    createRequestHandler,
    type Dispatch,
    type DispatchContext,
} from './handler.js';

/** The slice of the SDK transport the router uses, narrowed so tests can fake it. */
export interface HttpMcpTransport {
    sessionId?: string;
    handleRequest(
        req: IncomingMessage,
        res: ServerResponse,
        parsedBody?: unknown,
    ): Promise<void>;
    close(): Promise<void>;
}

export interface SessionHooks {
    onInitialized(sessionId: string): void;
    onClosed(sessionId: string): void;
}

export interface SessionRouterDeps {
    createSession(hooks: SessionHooks): Promise<HttpMcpTransport>;
    log?: (message: string) => void;
}

function jsonRpcError(code: number, message: string): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        error: { code, message },
        id: null,
    });
}

function send(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
    });
    res.end(body);
}

export class McpSessionRouter {
    private readonly sessions = new Map<string, HttpMcpTransport>();
    private readonly deps: SessionRouterDeps;
    private readonly log: (message: string) => void;

    constructor(deps: SessionRouterDeps) {
        this.deps = deps;
        this.log = deps.log ?? (() => {});
        this.dispatch = this.dispatch.bind(this);
    }

    get sessionCount(): number {
        return this.sessions.size;
    }

    dispatch: Dispatch = async (
        req: IncomingMessage,
        res: ServerResponse,
        ctx: DispatchContext,
    ): Promise<void> => {
        const header = req.headers['mcp-session-id'];
        const sessionId = typeof header === 'string' ? header : undefined;

        if (sessionId !== undefined) {
            const transport = this.sessions.get(sessionId);
            if (!transport) {
                // Spec: a request carrying a session id the server does not
                // know is 404, and the client re-initializes. Never a silent
                // upgrade to a fresh session, even for an initialize body.
                this.log(`unknown session ${sessionId} from ${ctx.principal}`);
                send(res, 404, jsonRpcError(-32001, 'Session not found'));
                return;
            }
            await transport.handleRequest(req, res, ctx.body);
            return;
        }

        if (req.method !== 'POST' || !isInitializeRequest(ctx.body)) {
            send(
                res,
                400,
                jsonRpcError(
                    -32000,
                    'Mcp-Session-Id header required except on initialize',
                ),
            );
            return;
        }

        const transport = await this.deps.createSession({
            onInitialized: (id) => {
                this.sessions.set(id, transport);
                this.log(`session ${id} opened for ${ctx.principal}`);
            },
            onClosed: (id) => {
                this.sessions.delete(id);
                this.log(`session ${id} closed`);
            },
        });

        await transport.handleRequest(req, res, ctx.body);
    };

    async closeAll(): Promise<void> {
        const open = [...this.sessions.values()];
        this.sessions.clear();
        await Promise.allSettled(open.map((transport) => transport.close()));
    }
}

export interface HttpTransportHandle {
    server: Server;
    router: McpSessionRouter;
    close(): Promise<void>;
}

export interface StartHttpTransportDeps {
    config: HttpTransportConfig;
    /** Builds a fresh, fully-registered MCP server for one session. */
    createServer(): McpServer;
    log?: (message: string) => void;
}

/**
 * Build (but do not listen on) the HTTP transport.
 *
 * Split from `listen` so the assembly is exercisable without binding a port.
 */
export function buildHttpTransport(
    deps: StartHttpTransportDeps,
): HttpTransportHandle {
    const log =
        deps.log ??
        ((message: string) => console.error(`[jules-mcp] ${message}`));

    const router = new McpSessionRouter({
        log,
        createSession: async (hooks) => {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                // JSON responses, no SSE. See the GET-405 note above.
                enableJsonResponse: true,
                onsessioninitialized: hooks.onInitialized,
                onsessionclosed: hooks.onClosed,
                // Belt to ./handler.ts's braces: the handler validates Origin
                // before anything reaches here, and the SDK re-checks it.
                enableDnsRebindingProtection:
                    deps.config.allowedOrigins.length > 0,
                allowedOrigins: deps.config.allowedOrigins,
            });
            const mcp = deps.createServer();
            transport.onclose = () => {
                void mcp.close();
            };
            await mcp.connect(transport);
            return transport;
        },
    });

    const handler = createRequestHandler({
        config: deps.config,
        dispatch: router.dispatch,
        log,
    });

    const server = createServer((req, res) => {
        void handler(req, res);
    });

    return {
        server,
        router,
        close: async () => {
            await router.closeAll();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** Build and listen. Diagnostics go to stderr -- stdout belongs to stdio MCP. */
export async function startHttpTransport(
    deps: StartHttpTransportDeps,
): Promise<HttpTransportHandle> {
    const handle = buildHttpTransport(deps);
    const { host, port, path, bindsBeyondLoopback, proxySecret } = deps.config;

    await new Promise<void>((resolve, reject) => {
        handle.server.once('error', reject);
        handle.server.listen(port, host, () => {
            handle.server.removeListener('error', reject);
            resolve();
        });
    });

    console.error(
        `[jules-mcp] streamable-HTTP transport listening on http://${host}:${port}${path}`,
    );
    console.error(
        `[jules-mcp] bearer authentication required on every request; GET ${path} answers 405 (no SSE stream)`,
    );
    console.error(
        `[jules-mcp] proxy identity header: ${proxySecret ? 'enabled (shared secret required)' : 'disabled'}`,
    );
    if (bindsBeyondLoopback) {
        console.error(
            `[jules-mcp] WARNING: bound to ${host}, which is not loopback. Authentication is ` +
                `unconditional either way -- but note that a loopback bind is not a containment ` +
                `boundary on this fleet either, because a socat relay re-originates connections ` +
                `from 127.0.0.1 (Redmine #50662).`,
        );
    }

    return handle;
}
