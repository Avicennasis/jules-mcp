/**
 * Outbound transport: proxy / no-proxy pairing (#50424).
 *
 * The behaviour worth pinning is the PAIRING: with no proxy configured the
 * server must use the global fetch and never load undici (no cost on the hot
 * path), and with a proxy configured it must route through undici's own fetch
 * with an EnvHttpProxyAgent dispatcher. The two must not be confused, and the
 * choice must be made lazily rather than at import time.
 *
 * `undici` is mocked, so nothing here touches the network or a real proxy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
    const instances: Array<Record<string, unknown>> = [];
    const EnvHttpProxyAgent = vi.fn(function (this: Record<string, unknown>) {
        this.kind = 'EnvHttpProxyAgent';
        instances.push(this);
    });
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    return { EnvHttpProxyAgent, fetch, instances };
});

vi.mock('undici', () => ({
    fetch: mocks.fetch,
    EnvHttpProxyAgent: mocks.EnvHttpProxyAgent,
}));

import { resolveFetch, resetFetchTransport } from '../src/transport.js';

const PROXY_VARS = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
];

describe('outbound transport (proxy support)', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const v of PROXY_VARS) {
            saved[v] = process.env[v];
            delete process.env[v];
        }
        resetFetchTransport();
        mocks.EnvHttpProxyAgent.mockClear();
        mocks.fetch.mockClear();
        mocks.instances.length = 0;
    });

    afterEach(() => {
        for (const v of PROXY_VARS) {
            if (saved[v] === undefined) delete process.env[v];
            else process.env[v] = saved[v];
        }
        resetFetchTransport();
    });

    it('with no proxy: returns the global fetch and never loads undici', async () => {
        const f = await resolveFetch();
        expect(f).toBe(globalThis.fetch);
        expect(mocks.EnvHttpProxyAgent).not.toHaveBeenCalled();
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('with HTTPS_PROXY: routes through undici fetch + EnvHttpProxyAgent', async () => {
        process.env.HTTPS_PROXY = 'http://proxy.example:3128';
        const f = await resolveFetch();
        expect(f).not.toBe(globalThis.fetch);

        await f('https://jules.googleapis.com/v1alpha/sources', {
            method: 'GET',
            headers: { 'X-Goog-Api-Key': 'k' },
        });

        expect(mocks.EnvHttpProxyAgent).toHaveBeenCalledTimes(1);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = mocks.fetch.mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
        ];
        expect(url).toBe('https://jules.googleapis.com/v1alpha/sources');
        expect(init.method).toBe('GET');
        // The dispatcher is what carries the proxy, and it must be the instance
        // constructed for this transport.
        expect(init.dispatcher).toBe(mocks.instances[0]);
    });

    it('with HTTP_PROXY only (no HTTPS_PROXY): also proxied', async () => {
        process.env.HTTP_PROXY = 'http://proxy.example:3128';
        const f = await resolveFetch();
        expect(f).not.toBe(globalThis.fetch);
    });

    it('caches per proxy env: same env reuses, changed env re-resolves', async () => {
        process.env.HTTPS_PROXY = 'http://a:1';
        const first = await resolveFetch();
        expect(await resolveFetch()).toBe(first);
        expect(mocks.EnvHttpProxyAgent).toHaveBeenCalledTimes(1);

        process.env.HTTPS_PROXY = 'http://b:2';
        const second = await resolveFetch();
        expect(second).not.toBe(first);
        expect(mocks.EnvHttpProxyAgent).toHaveBeenCalledTimes(2);

        delete process.env.HTTPS_PROXY;
        expect(await resolveFetch()).toBe(globalThis.fetch);
    });

    it('is lazy: a proxy set after import is still honoured', async () => {
        // The module was imported at the top of this file with no proxy set.
        process.env.HTTPS_PROXY = 'http://late:8080';
        const f = await resolveFetch();
        expect(f).not.toBe(globalThis.fetch);
    });
});
