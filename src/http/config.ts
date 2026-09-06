/**
 * Configuration and transport selection for the streamable-HTTP transport
 * (Redmine #50638).
 *
 * Two properties this file is responsible for:
 *
 * OPT-IN. `resolveTransportMode` defaults to stdio. Setting a port or a token
 * configures the HTTP transport but does not start it; only
 * `JULES_MCP_TRANSPORT=http` or `--transport http` does. `npm start` keeps
 * behaving exactly as it did before this module existed.
 *
 * FAIL-CLOSED. `loadHttpConfig` throws when there is no token. It does not
 * boot with a warning, and it does not relax that for a loopback bind — see
 * the #50638 journal note and #50662: a socat relay in front of a loopback
 * listener re-originates every connection, so the peer address is 127.0.0.1
 * for the whole tailnet and tells you nothing about who is calling.
 */

/** Thrown for any unusable transport configuration. Never recovered from. */
export class HttpConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HttpConfigError';
    }
}

export type TransportMode = 'stdio' | 'http';

export interface HttpTransportConfig {
    host: string;
    port: number;
    /** The single MCP endpoint path. Everything else 404s. */
    path: string;
    token: string;
    proxySecret?: string;
    allowedOrigins: string[];
    maxBodyBytes: number;
    /**
     * True when `host` is not a loopback address. Used ONLY to print an
     * operator warning — no security decision reads it, by design.
     */
    bindsBeyondLoopback: boolean;
}

const DEFAULT_PORT = 9673;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PATH = '/mcp';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Minimum shared-secret length. 32 characters is what `openssl rand -hex 16`
 * produces; the point is to make an operator paste a generated value rather
 * than type a password they can remember.
 */
const MIN_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;

/**
 * Decide which transport to run. The command-line flag wins over the
 * environment so a wrapper script can override an inherited variable.
 */
export function resolveTransportMode(
    env: Env,
    argv: readonly string[],
): TransportMode {
    let requested = env.JULES_MCP_TRANSPORT;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg.startsWith('--transport=')) {
            requested = arg.slice('--transport='.length);
        } else if (arg === '--transport') {
            requested = argv[i + 1];
        }
    }

    if (requested === undefined || requested === '') return 'stdio';
    if (requested === 'stdio' || requested === 'http') return requested;
    throw new HttpConfigError(
        `unknown transport '${requested}' -- expected 'stdio' or 'http'`,
    );
}

function requiredSecret(value: string | undefined, name: string): string {
    if (value === undefined || value.trim() === '') {
        throw new HttpConfigError(
            `${name} is required to run the HTTP transport. Generate one with ` +
                `\`openssl rand -hex 32\`. There is no unauthenticated mode: an ` +
                `HTTP surface in front of Jules tool dispatch inherits the API ` +
                `key's full authority (Redmine #50775).`,
        );
    }
    if (value.length < MIN_SECRET_LENGTH) {
        throw new HttpConfigError(
            `${name} must be at least ${MIN_SECRET_LENGTH} characters`,
        );
    }
    return value;
}

function parsePort(value: string | undefined): number {
    if (value === undefined || value === '') return DEFAULT_PORT;
    if (!/^[0-9]+$/.test(value)) {
        throw new HttpConfigError(`JULES_MCP_HTTP_PORT must be an integer`);
    }
    const port = Number(value);
    if (port < 1 || port > 65535) {
        throw new HttpConfigError(
            `JULES_MCP_HTTP_PORT must be between 1 and 65535`,
        );
    }
    return port;
}

function parseOrigins(value: string | undefined): string[] {
    if (value === undefined || value.trim() === '') return [];
    const origins = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
    if (origins.includes('*')) {
        throw new HttpConfigError(
            `JULES_MCP_HTTP_ALLOWED_ORIGINS must not contain '*'. A wildcard ` +
                `CORS origin on an endpoint holding a Jules API key is the ` +
                `defect recorded against the reference implementation in #50638.`,
        );
    }
    return origins;
}

/**
 * Loopback detection, for the operator warning only.
 *
 * Deliberately narrow and deliberately inconsequential: the whole 127.0.0.0/8
 * block plus `localhost` and `::1`. Nothing in the request path branches on
 * this value.
 */
function isLoopbackHost(host: string): boolean {
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
    return /^127\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host);
}

export function loadHttpConfig(env: Env): HttpTransportConfig {
    const token = requiredSecret(
        env.JULES_MCP_HTTP_TOKEN,
        'JULES_MCP_HTTP_TOKEN',
    );

    const rawProxySecret = env.JULES_MCP_HTTP_PROXY_SECRET;
    const proxySecret =
        rawProxySecret === undefined || rawProxySecret === ''
            ? undefined
            : requiredSecret(rawProxySecret, 'JULES_MCP_HTTP_PROXY_SECRET');

    const host = env.JULES_MCP_HTTP_HOST || DEFAULT_HOST;
    const path = env.JULES_MCP_HTTP_PATH || DEFAULT_PATH;
    if (!path.startsWith('/')) {
        throw new HttpConfigError(
            `JULES_MCP_HTTP_PATH must start with '/' (got '${path}')`,
        );
    }

    const rawMaxBody = env.JULES_MCP_HTTP_MAX_BODY_BYTES;
    let maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
    if (rawMaxBody !== undefined && rawMaxBody !== '') {
        if (!/^[0-9]+$/.test(rawMaxBody) || Number(rawMaxBody) < 1) {
            throw new HttpConfigError(
                `JULES_MCP_HTTP_MAX_BODY_BYTES must be a positive integer`,
            );
        }
        maxBodyBytes = Number(rawMaxBody);
    }

    return {
        host,
        port: parsePort(env.JULES_MCP_HTTP_PORT),
        path,
        token,
        proxySecret,
        allowedOrigins: parseOrigins(env.JULES_MCP_HTTP_ALLOWED_ORIGINS),
        maxBodyBytes,
        bindsBeyondLoopback: !isLoopbackHost(host),
    };
}
