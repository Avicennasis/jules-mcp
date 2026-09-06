/**
 * The HTTP shell in front of MCP dispatch (Redmine #50638).
 *
 * Order of operations, and it is the substance of the module:
 *
 *   path -> Origin -> AUTHENTICATION -> method -> body -> dispatch
 *
 * Authentication sits ahead of the method switch and ahead of the body read,
 * so an unauthenticated request is answered before anything it supplied is
 * parsed and long before anything reaches a tool. #50775 is the worked example
 * of getting this wrong: a public `POST /mcp/execute` with no inbound auth
 * that forwarded the request body straight into the Jules API with the
 * deployer's own key.
 *
 * There is exactly one dispatch route and it goes through `dispatch`, which is
 * injected. There is no fallback path, no "be lenient about the session id"
 * branch, and no second entry point. #50652's `CatchAllMessagesFallbackMiddleware`
 * was added to be forgiving about expired session ids and ended up skipping
 * session validation entirely; leniency added for convenience became the hole.
 *
 * Nothing here writes to stdout. stdout belongs to the stdio transport, and
 * both transports live in the same binary.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpTransportConfig } from './config.js';
import { authenticateRequest, validateOrigin } from './guards.js';

export interface DispatchContext {
    /** Who the request authenticated as: `bearer` or `proxy:<identity>`. */
    principal: string;
    /** Parsed JSON body for POST; undefined for DELETE. */
    body?: unknown;
}

export type Dispatch = (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: DispatchContext,
) => Promise<void>;

export interface HandlerDeps {
    config: HttpTransportConfig;
    dispatch: Dispatch;
    /** Diagnostics sink. Must not be stdout. */
    log?: (message: string) => void;
}

/** Methods the endpoint answers at all. GET is answered, with a 405. */
const ALLOW = 'POST, DELETE, OPTIONS';

const CORS_HEADERS =
    'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version';

function jsonRpcError(code: number, message: string): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        error: { code, message },
        id: null,
    });
}

/**
 * Read the request body with a hard byte cap.
 *
 * The cap is enforced as bytes arrive rather than trusting Content-Length, so
 * a lying or absent Content-Length cannot get past it.
 */
async function readBody(
    req: IncomingMessage,
    maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) return { ok: false };
        chunks.push(buf);
    }
    return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

export function createRequestHandler(deps: HandlerDeps) {
    const { config, dispatch } = deps;
    const log = deps.log ?? (() => {});

    function send(
        res: ServerResponse,
        status: number,
        body: string,
        headers: Record<string, string> = {},
    ): void {
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            ...headers,
        });
        res.end(body);
    }

    return async function handle(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        // `req.url` is a path, never absolute, so the base is inert.
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname !== config.path) {
            send(res, 404, jsonRpcError(-32601, 'Not found'));
            return;
        }

        const originOutcome = validateOrigin(
            req.headers.origin,
            config.allowedOrigins,
        );
        if (!originOutcome.ok) {
            log(`rejected ${req.method} ${pathname}: ${originOutcome.message}`);
            send(
                res,
                originOutcome.status,
                jsonRpcError(-32000, originOutcome.message),
            );
            return;
        }

        // Only ever echo an origin we matched exactly. Never '*'.
        const corsHeaders: Record<string, string> = originOutcome.echo
            ? {
                  'Access-Control-Allow-Origin': originOutcome.echo,
                  'Access-Control-Allow-Methods': ALLOW,
                  'Access-Control-Allow-Headers': CORS_HEADERS,
                  Vary: 'Origin',
              }
            : {};

        // A preflight carries no credentials by definition, so it is answered
        // before the auth gate -- it is also the only request that is.
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Content-Length': '0', ...corsHeaders });
            res.end();
            return;
        }

        const auth = authenticateRequest(req.headers, {
            token: config.token,
            proxySecret: config.proxySecret,
        });
        if (!auth.ok) {
            log(`rejected ${req.method} ${pathname}: unauthenticated`);
            send(res, auth.status, jsonRpcError(-32000, auth.message), {
                'WWW-Authenticate': 'Bearer realm="jules-mcp"',
                ...corsHeaders,
            });
            return;
        }

        if (req.method === 'GET') {
            // Spec 2025-06-18: the server MUST return text/event-stream OR
            // 405 for a GET on the MCP endpoint. We do not offer the optional
            // server-initiated SSE stream, and 405 is how that is said. The
            // official SDK client handles it as `return` (its
            // streamableHttp.js: `if (response.status === 405) return`), so
            // the session continues POST-only rather than erroring.
            send(
                res,
                405,
                jsonRpcError(
                    -32000,
                    'No SSE stream at this endpoint; use POST (MCP Streamable HTTP, SSE is optional)',
                ),
                { Allow: ALLOW, ...corsHeaders },
            );
            return;
        }

        if (req.method !== 'POST' && req.method !== 'DELETE') {
            send(res, 405, jsonRpcError(-32000, 'Method not allowed'), {
                Allow: ALLOW,
                ...corsHeaders,
            });
            return;
        }

        let body: unknown;
        if (req.method === 'POST') {
            const read = await readBody(req, config.maxBodyBytes);
            if (!read.ok) {
                log(
                    `rejected POST ${pathname}: body over ${config.maxBodyBytes} bytes`,
                );
                send(
                    res,
                    413,
                    jsonRpcError(-32000, 'Payload too large'),
                    corsHeaders,
                );
                return;
            }
            try {
                body = JSON.parse(read.text);
            } catch {
                send(
                    res,
                    400,
                    jsonRpcError(-32700, 'Parse error'),
                    corsHeaders,
                );
                return;
            }
        }

        for (const [name, value] of Object.entries(corsHeaders)) {
            res.setHeader(name, value);
        }

        try {
            await dispatch(req, res, { principal: auth.principal, body });
        } catch (error) {
            // The message may quote a request we forwarded or an upstream
            // error carrying configuration; it goes to the log, not the wire.
            log(
                `dispatch failed for ${auth.principal}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            if (!res.headersSent) {
                send(
                    res,
                    500,
                    jsonRpcError(-32603, 'Internal error'),
                    corsHeaders,
                );
            }
        }
    };
}
