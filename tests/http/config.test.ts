/**
 * Configuration for the streamable-HTTP transport (Redmine #50638).
 *
 * The two properties worth defending here are OPT-IN and FAIL-CLOSED:
 * stdio stays the default transport so `npm start` is unchanged, and the HTTP
 * transport refuses to start at all without a token. A server that boots
 * without credentials and logs a warning is #50775 with extra steps.
 */
import { describe, it, expect } from 'vitest';
import {
    loadHttpConfig,
    resolveTransportMode,
    HttpConfigError,
} from '../../src/http/config.js';

const TOKEN = 'a'.repeat(32);
const base = { JULES_MCP_HTTP_TOKEN: TOKEN };

describe('resolveTransportMode', () => {
    it('defaults to stdio with no env and no flags', () => {
        expect(resolveTransportMode({}, [])).toBe('stdio');
    });

    it('stays stdio even when HTTP settings are present but unselected', () => {
        // Configuring a port must not silently open a socket. Selecting the
        // transport is a separate, explicit act.
        expect(
            resolveTransportMode(
                { JULES_MCP_HTTP_PORT: '9673', JULES_MCP_HTTP_TOKEN: TOKEN },
                [],
            ),
        ).toBe('stdio');
    });

    it('selects http via JULES_MCP_TRANSPORT', () => {
        expect(resolveTransportMode({ JULES_MCP_TRANSPORT: 'http' }, [])).toBe(
            'http',
        );
    });

    it('selects http via --transport=http and --transport http', () => {
        expect(resolveTransportMode({}, ['--transport=http'])).toBe('http');
        expect(resolveTransportMode({}, ['--transport', 'http'])).toBe('http');
    });

    it('lets the flag override the environment', () => {
        expect(
            resolveTransportMode({ JULES_MCP_TRANSPORT: 'http' }, [
                '--transport=stdio',
            ]),
        ).toBe('stdio');
    });

    it('rejects an unrecognised transport instead of guessing', () => {
        expect(() =>
            resolveTransportMode({ JULES_MCP_TRANSPORT: 'sse' }, []),
        ).toThrow(HttpConfigError);
        expect(() =>
            resolveTransportMode({}, ['--transport=websocket']),
        ).toThrow(HttpConfigError);
    });
});

describe('loadHttpConfig — defaults', () => {
    it('binds loopback on 9673 at /mcp', () => {
        const config = loadHttpConfig(base);
        expect(config.host).toBe('127.0.0.1');
        expect(config.port).toBe(9673);
        expect(config.path).toBe('/mcp');
    });

    it('allows no origins by default', () => {
        expect(loadHttpConfig(base).allowedOrigins).toEqual([]);
    });

    it('leaves the proxy path disabled by default', () => {
        expect(loadHttpConfig(base).proxySecret).toBeUndefined();
    });

    it('caps the request body at 1 MiB', () => {
        expect(loadHttpConfig(base).maxBodyBytes).toBe(1024 * 1024);
    });

    it('reports that the default bind does not reach beyond loopback', () => {
        expect(loadHttpConfig(base).bindsBeyondLoopback).toBe(false);
    });
});

describe('loadHttpConfig — token', () => {
    it('refuses to start without a token', () => {
        expect(() => loadHttpConfig({})).toThrow(HttpConfigError);
    });

    it('refuses a token shorter than 32 characters', () => {
        expect(() =>
            loadHttpConfig({ JULES_MCP_HTTP_TOKEN: 'a'.repeat(31) }),
        ).toThrow(HttpConfigError);
    });

    it('refuses a whitespace-only token', () => {
        expect(() =>
            loadHttpConfig({ JULES_MCP_HTTP_TOKEN: ' '.repeat(40) }),
        ).toThrow(HttpConfigError);
    });

    it('accepts a 32-character token', () => {
        expect(loadHttpConfig(base).token).toBe(TOKEN);
    });
});

describe('loadHttpConfig — proxy secret', () => {
    it('accepts a long enough secret', () => {
        const config = loadHttpConfig({
            ...base,
            JULES_MCP_HTTP_PROXY_SECRET: 'b'.repeat(32),
        });
        expect(config.proxySecret).toBe('b'.repeat(32));
    });

    it('refuses a short secret rather than downgrading to disabled', () => {
        // Silently ignoring a too-short secret would leave an operator who
        // believes the proxy path is on with the proxy path off, or worse.
        expect(() =>
            loadHttpConfig({
                ...base,
                JULES_MCP_HTTP_PROXY_SECRET: 'short',
            }),
        ).toThrow(HttpConfigError);
    });

    it('treats an empty secret as unset', () => {
        expect(
            loadHttpConfig({ ...base, JULES_MCP_HTTP_PROXY_SECRET: '' })
                .proxySecret,
        ).toBeUndefined();
    });
});

describe('loadHttpConfig — origins', () => {
    it('parses a comma-separated list and trims it', () => {
        expect(
            loadHttpConfig({
                ...base,
                JULES_MCP_HTTP_ALLOWED_ORIGINS:
                    'http://localhost:3000, https://app.example',
            }).allowedOrigins,
        ).toEqual(['http://localhost:3000', 'https://app.example']);
    });

    it('refuses a wildcard origin', () => {
        expect(() =>
            loadHttpConfig({ ...base, JULES_MCP_HTTP_ALLOWED_ORIGINS: '*' }),
        ).toThrow(HttpConfigError);
        expect(() =>
            loadHttpConfig({
                ...base,
                JULES_MCP_HTTP_ALLOWED_ORIGINS: 'http://localhost:3000,*',
            }),
        ).toThrow(HttpConfigError);
    });
});

describe('loadHttpConfig — port and path', () => {
    it('rejects a non-numeric or out-of-range port', () => {
        for (const port of ['nope', '0', '65536', '-1', '80.5']) {
            expect(() =>
                loadHttpConfig({ ...base, JULES_MCP_HTTP_PORT: port }),
            ).toThrow(HttpConfigError);
        }
    });

    it('rejects a path that is not absolute', () => {
        expect(() =>
            loadHttpConfig({ ...base, JULES_MCP_HTTP_PATH: 'mcp' }),
        ).toThrow(HttpConfigError);
    });
});

describe('loadHttpConfig — bind address', () => {
    it('flags a non-loopback bind for the operator', () => {
        const config = loadHttpConfig({
            ...base,
            JULES_MCP_HTTP_HOST: '0.0.0.0',
        });
        expect(config.host).toBe('0.0.0.0');
        expect(config.bindsBeyondLoopback).toBe(true);
    });

    it('recognises the loopback forms', () => {
        for (const host of ['127.0.0.1', 'localhost', '::1', '127.0.0.53']) {
            expect(
                loadHttpConfig({ ...base, JULES_MCP_HTTP_HOST: host })
                    .bindsBeyondLoopback,
            ).toBe(false);
        }
    });

    it('does not relax any credential requirement for a loopback bind', () => {
        // #50638 journal / #50662: a loopback bind is not an authentication
        // decision, because a socat relay in front of it re-originates every
        // connection from 127.0.0.1. If this ever starts passing, the "auth
        // only when remote" bug is back.
        expect(() =>
            loadHttpConfig({ JULES_MCP_HTTP_HOST: '127.0.0.1' }),
        ).toThrow(HttpConfigError);
    });
});
