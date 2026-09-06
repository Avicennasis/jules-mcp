/**
 * Guards for the streamable-HTTP transport (Redmine #50638).
 *
 * These tests exist because of the journal note on #50638: two of that
 * ticket's original acceptance criteria treated "bound to loopback" as
 * equivalent to "reachable only from this host", and on this fleet it is not
 * (socat relays re-originate connections, so the backend sees 127.0.0.1 as the
 * peer for every relayed request). So the property under test throughout this
 * file is that NO decision here reads a peer address at all — authentication
 * is unconditional, and the proxy path is disabled unless a shared secret is
 * configured.
 *
 * The negative knowledge behind it: #50652 (unauthenticated 0.0.0.0 listener
 * dispatching through globals()) and #50775 (publicly-deployed unauthenticated
 * /mcp/execute forwarding to Jules with the deployer's own API key).
 */
import { describe, it, expect } from 'vitest';
import {
    constantTimeEquals,
    authenticateRequest,
    validateOrigin,
} from '../../src/http/guards.js';

const TOKEN = 'a'.repeat(32);
const PROXY_SECRET = 'b'.repeat(32);

describe('constantTimeEquals', () => {
    it('accepts identical strings', () => {
        expect(constantTimeEquals('hunter2hunter2', 'hunter2hunter2')).toBe(
            true,
        );
    });

    it('rejects strings that differ only in the last character', () => {
        expect(constantTimeEquals('hunter2hunter2', 'hunter2hunter3')).toBe(
            false,
        );
    });

    it('rejects a prefix of the expected value', () => {
        expect(constantTimeEquals('hunter2', 'hunter2hunter2')).toBe(false);
    });

    it('rejects when either side is empty', () => {
        expect(constantTimeEquals('', '')).toBe(false);
        expect(constantTimeEquals('', TOKEN)).toBe(false);
        expect(constantTimeEquals(TOKEN, '')).toBe(false);
    });

    it('compares different-length inputs without throwing', () => {
        // crypto.timingSafeEqual throws on length mismatch, so the
        // implementation must digest first rather than compare raw bytes.
        expect(() => constantTimeEquals('a', 'a'.repeat(4096))).not.toThrow();
    });

    it('is not a substring or case-insensitive match', () => {
        expect(constantTimeEquals('HUNTER2HUNTER2', 'hunter2hunter2')).toBe(
            false,
        );
        expect(constantTimeEquals('xhunter2hunter2x', 'hunter2hunter2')).toBe(
            false,
        );
    });
});

describe('authenticateRequest — bearer path', () => {
    it('accepts the configured token', () => {
        const out = authenticateRequest(
            { authorization: `Bearer ${TOKEN}` },
            { token: TOKEN },
        );
        expect(out.ok).toBe(true);
        expect(out.ok && out.via).toBe('bearer');
        expect(out.ok && out.principal).toBe('bearer');
    });

    it('is case-insensitive on the "Bearer" scheme word only', () => {
        expect(
            authenticateRequest(
                { authorization: `bearer ${TOKEN}` },
                { token: TOKEN },
            ).ok,
        ).toBe(true);
        expect(
            authenticateRequest(
                { authorization: `Bearer ${TOKEN.toUpperCase()}` },
                { token: TOKEN },
            ).ok,
        ).toBe(false);
    });

    it('rejects a wrong token', () => {
        const out = authenticateRequest(
            { authorization: `Bearer ${'c'.repeat(32)}` },
            { token: TOKEN },
        );
        expect(out.ok).toBe(false);
        expect(!out.ok && out.status).toBe(401);
    });

    it('rejects a missing Authorization header', () => {
        expect(authenticateRequest({}, { token: TOKEN }).ok).toBe(false);
    });

    it('rejects a non-Bearer scheme carrying the right token', () => {
        expect(
            authenticateRequest(
                { authorization: `Basic ${TOKEN}` },
                { token: TOKEN },
            ).ok,
        ).toBe(false);
    });

    it('rejects a duplicated Authorization header (array value)', () => {
        // Node surfaces repeated headers as an array for some names. Two
        // candidate credentials is a smuggling shape, not a login.
        expect(
            authenticateRequest(
                {
                    authorization: [
                        `Bearer ${TOKEN}`,
                        'Bearer nope',
                    ] as unknown as string,
                },
                { token: TOKEN },
            ).ok,
        ).toBe(false);
    });

    it('denies everything when no token is configured (fail closed)', () => {
        // The loader refuses to start without a token; this is the belt to
        // that braces. An empty configured secret must never match an empty
        // supplied one.
        expect(
            authenticateRequest({ authorization: 'Bearer ' }, { token: '' }).ok,
        ).toBe(false);
        expect(authenticateRequest({}, { token: '' }).ok).toBe(false);
    });
});

describe('authenticateRequest — proxy path', () => {
    it('accepts a matching X-Forwarded-Auth-Secret and reports the identity', () => {
        const out = authenticateRequest(
            {
                'x-forwarded-auth-secret': PROXY_SECRET,
                'x-forwarded-user': 'leon',
            },
            { token: TOKEN, proxySecret: PROXY_SECRET },
        );
        expect(out.ok).toBe(true);
        expect(out.ok && out.via).toBe('proxy');
        expect(out.ok && out.principal).toBe('proxy:leon');
    });

    it('ignores the proxy headers entirely when no proxy secret is configured', () => {
        // #50638 journal: "absent secret disables the proxy path rather than
        // trusting the header". With no proxy secret and no bearer token in
        // the request, this must be a 401 — the identity header must not
        // authenticate anything on its own.
        const out = authenticateRequest(
            {
                'x-forwarded-auth-secret': PROXY_SECRET,
                'x-forwarded-user': 'leon',
            },
            { token: TOKEN },
        );
        expect(out.ok).toBe(false);
        expect(!out.ok && out.status).toBe(401);
    });

    it('does not let a proxy identity header alone authenticate', () => {
        expect(
            authenticateRequest(
                { 'x-forwarded-user': 'leon' },
                { token: TOKEN, proxySecret: PROXY_SECRET },
            ).ok,
        ).toBe(false);
    });

    it('rejects a wrong proxy secret outright rather than falling through', () => {
        const out = authenticateRequest(
            {
                'x-forwarded-auth-secret': 'd'.repeat(32),
                'x-forwarded-user': 'leon',
                authorization: `Bearer ${TOKEN}`,
            },
            { token: TOKEN, proxySecret: PROXY_SECRET },
        );
        expect(out.ok).toBe(false);
    });

    it('defaults the identity to "unknown" when the proxy sends no user', () => {
        const out = authenticateRequest(
            { 'x-forwarded-auth-secret': PROXY_SECRET },
            { token: TOKEN, proxySecret: PROXY_SECRET },
        );
        expect(out.ok).toBe(true);
        expect(out.ok && out.principal).toBe('proxy:unknown');
    });

    it('rejects a malformed proxy identity instead of logging it verbatim', () => {
        for (const bad of ['leon\nX-Admin: 1', 'a'.repeat(200), 'le on']) {
            const out = authenticateRequest(
                {
                    'x-forwarded-auth-secret': PROXY_SECRET,
                    'x-forwarded-user': bad,
                },
                { token: TOKEN, proxySecret: PROXY_SECRET },
            );
            expect(out.ok).toBe(false);
        }
    });

    it('still accepts the bearer token when the proxy path is configured but unused', () => {
        expect(
            authenticateRequest(
                { authorization: `Bearer ${TOKEN}` },
                { token: TOKEN, proxySecret: PROXY_SECRET },
            ).ok,
        ).toBe(true);
    });
});

describe('authenticateRequest — peer address independence', () => {
    it('reads no peer/forwarded-for information', () => {
        // The socat finding in #50662: the backend sees 127.0.0.1 for every
        // relayed request, so "is the caller local?" answers true for the
        // whole tailnet. Nothing here may consult those headers.
        const headers = {
            'x-forwarded-for': '127.0.0.1',
            'x-real-ip': '127.0.0.1',
            host: 'localhost:9673',
        };
        expect(authenticateRequest(headers, { token: TOKEN }).ok).toBe(false);
    });
});

describe('validateOrigin', () => {
    it('allows a request with no Origin header (non-browser client)', () => {
        expect(validateOrigin(undefined, []).ok).toBe(true);
    });

    it('rejects any Origin when the allowlist is empty (secure default)', () => {
        const out = validateOrigin('https://evil.example', []);
        expect(out.ok).toBe(false);
        expect(!out.ok && out.status).toBe(403);
    });

    it('allows an exactly-matching allowlisted Origin and echoes it', () => {
        const out = validateOrigin('http://localhost:3000', [
            'http://localhost:3000',
        ]);
        expect(out.ok).toBe(true);
        expect(out.ok && out.echo).toBe('http://localhost:3000');
    });

    it('never echoes a wildcard', () => {
        const out = validateOrigin('https://evil.example', ['*']);
        expect(out.ok).toBe(false);
    });

    it('does not match on suffix, prefix or scheme confusion', () => {
        const allowed = ['http://localhost:3000'];
        for (const origin of [
            'http://localhost:30000',
            'https://localhost:3000',
            'http://localhost:3000.evil.example',
            'http://evil.example/http://localhost:3000',
            'HTTP://LOCALHOST:3000',
        ]) {
            expect(validateOrigin(origin, allowed).ok).toBe(false);
        }
    });

    it('rejects a duplicated Origin header (array value)', () => {
        expect(
            validateOrigin(
                ['http://localhost:3000', 'https://evil.example'] as unknown as
                    string | undefined,
                ['http://localhost:3000'],
            ).ok,
        ).toBe(false);
    });
});
