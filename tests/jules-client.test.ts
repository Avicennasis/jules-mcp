import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JulesClient } from '../src/jules-client.js';
import {
    JulesAuthError,
    JulesNotFoundError,
    JulesRateLimitError,
} from '../src/errors.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

describe('JulesClient', () => {
    let client: JulesClient;

    beforeEach(() => {
        vi.resetAllMocks();
        client = new JulesClient('test-api-key');
    });

    describe('listSources', () => {
        it('returns sources array', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({
                    sources: [{ name: 'sources/github/owner/repo' }],
                }),
            );

            const result = await client.listSources();
            expect(result.sources).toEqual([
                { name: 'sources/github/owner/repo' },
            ]);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://jules.googleapis.com/v1alpha/sources',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-Goog-Api-Key': 'test-api-key',
                    }),
                }),
            );
        });
    });

    describe('createSession', () => {
        it('sends POST with session body', async () => {
            const session = {
                name: 'sessions/123',
                id: '123',
                state: 'QUEUED',
                prompt: 'fix bugs',
                sourceContext: { source: 'sources/github/o/r' },
                createTime: '2026-01-01T00:00:00Z',
                updateTime: '2026-01-01T00:00:00Z',
                url: 'https://jules.google/sessions/123',
            };
            mockFetch.mockResolvedValueOnce(jsonResponse(session));

            const result = await client.createSession({
                prompt: 'fix bugs',
                sourceContext: {
                    source: 'sources/github/o/r',
                    githubRepoContext: { startingBranch: 'main' },
                },
            });

            expect(result.id).toBe('123');
            expect(result.state).toBe('QUEUED');

            const [url, opts] = mockFetch.mock.calls[0];
            expect(url).toBe('https://jules.googleapis.com/v1alpha/sessions');
            expect(opts.method).toBe('POST');
            expect(JSON.parse(opts.body)).toMatchObject({ prompt: 'fix bugs' });
        });
    });

    describe('getSession', () => {
        it('normalizes bare session ID', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({
                    name: 'sessions/abc',
                    id: 'abc',
                    state: 'COMPLETED',
                    prompt: 'x',
                    sourceContext: { source: 's' },
                    createTime: '',
                    updateTime: '',
                    url: '',
                }),
            );

            await client.getSession('abc');
            expect(mockFetch.mock.calls[0][0]).toBe(
                'https://jules.googleapis.com/v1alpha/sessions/abc',
            );
        });
    });

    describe('approvePlan', () => {
        it('posts to the approvePlan action', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({
                    name: 'sessions/abc',
                    id: 'abc',
                    state: 'IN_PROGRESS',
                    prompt: 'x',
                    sourceContext: { source: 's' },
                    createTime: '',
                    updateTime: '',
                    url: '',
                }),
            );

            const result = await client.approvePlan('abc');
            expect(result.state).toBe('IN_PROGRESS');
            expect(mockFetch.mock.calls[0][0]).toContain(':approvePlan');
        });
    });

    describe('sendMessage', () => {
        it('posts the text under the "prompt" field (not "message")', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({
                    name: 'sessions/abc',
                    id: 'abc',
                    state: 'IN_PROGRESS',
                    prompt: 'x',
                    sourceContext: { source: 's' },
                    createTime: '',
                    updateTime: '',
                    url: '',
                }),
            );

            await client.sendMessage('abc', 'hello there');
            const [url, opts] = mockFetch.mock.calls[0];
            expect(url).toContain(':sendMessage');
            const body = JSON.parse(opts.body);
            expect(body.prompt).toBe('hello there');
            expect(body.message).toBeUndefined();
        });

        // The real endpoint returns google.protobuf.Empty. Parsing that as JSON
        // threw, surfacing as a 500 to the caller even though the POST had
        // already succeeded (#30).
        it('resolves when the API returns a completely empty body', async () => {
            mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));
            await expect(
                client.sendMessage('abc', 'hello'),
            ).resolves.toBeUndefined();
        });

        it('resolves when the API returns an empty JSON object', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({}));
            await expect(client.sendMessage('abc', 'hello')).resolves.toEqual(
                {},
            );
        });
    });

    describe('archiveSession / unarchiveSession', () => {
        function sessionResponse(archived: boolean) {
            return jsonResponse({
                name: 'sessions/abc',
                id: 'abc',
                state: 'COMPLETED',
                prompt: 'x',
                sourceContext: { source: 's' },
                createTime: '',
                updateTime: '',
                url: '',
                archived,
            });
        }

        it('archiveSession POSTs to :archive and returns the session', async () => {
            mockFetch.mockResolvedValueOnce(sessionResponse(true));
            const session = await client.archiveSession('abc');
            const [url, opts] = mockFetch.mock.calls[0];
            expect(url).toContain('/sessions/abc:archive');
            expect(opts.method).toBe('POST');
            expect(session.archived).toBe(true);
        });

        it('unarchiveSession POSTs to :unarchive', async () => {
            mockFetch.mockResolvedValueOnce(sessionResponse(false));
            const session = await client.unarchiveSession('abc');
            const [url, opts] = mockFetch.mock.calls[0];
            expect(url).toContain('/sessions/abc:unarchive');
            expect(opts.method).toBe('POST');
            expect(session.archived).toBe(false);
        });
    });

    describe('deleteSession', () => {
        it('issues a DELETE and tolerates an empty body', async () => {
            // 204 No Content with an empty body would break response.json();
            // the client must not attempt to parse it.
            mockFetch.mockResolvedValueOnce(
                new Response(null, { status: 204 }),
            );
            await expect(client.deleteSession('abc')).resolves.toBeUndefined();
            const [url, opts] = mockFetch.mock.calls[0];
            expect(url).toContain('/sessions/abc');
            expect(opts.method).toBe('DELETE');
        });
    });

    describe('error handling', () => {
        // Retries OFF here on purpose. These assert STATUS -> TYPED ERROR
        // mapping, and the retrying client (default since #50643) replays a 429
        // before mapping it — which would leave these testing the retry loop
        // instead. Two of them silently passed for the wrong reason when the
        // retry landed: the mock ran out on the second attempt, the client
        // threw a TypeError, and `err.retryAfter` was undefined on THAT, which
        // is what the assertion wanted. Retry behaviour is covered in
        // `JulesClient retry` below.
        let client: JulesClient;
        beforeEach(() => {
            client = new JulesClient('test-api-key', { retries: 0 });
        });

        it('throws JulesAuthError on 401', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ error: 'unauth' }, 401),
            );
            await expect(client.listSources()).rejects.toThrow(JulesAuthError);
        });

        it('throws JulesAuthError on 403', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ error: 'forbidden' }, 403),
            );
            await expect(client.listSources()).rejects.toThrow(JulesAuthError);
        });

        it('throws JulesNotFoundError on 404', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ error: 'nope' }, 404),
            );
            await expect(client.getSession('nope')).rejects.toThrow(
                JulesNotFoundError,
            );
        });

        it('throws JulesRateLimitError on 429 with retry-after', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ error: 'slow down' }, 429, {
                    'retry-after': '60',
                }),
            );
            const err = await client.listSources().catch((e) => e);
            expect(err).toBeInstanceOf(JulesRateLimitError);
            expect(err.retryAfter).toBe(60);
        });

        // jules-mcp#50648. These assert the CLIENT actually routes the header
        // through parseRetryAfterSeconds — a unit test of that parser passes
        // whether or not handleError was ever changed.
        // NOTE on coverage: only the garbage case witnesses the old bug at this
        // layer. `''` was already falsy so the old ternary returned undefined,
        // `'0'` was already truthy so parseInt returned 0 — both were correct
        // before. And a whitespace-only header cannot reach the client at all:
        // the Headers API trims header values, so `{'retry-after': '   '}`
        // arrives as `''`. That input is covered in tests/retry-after.test.ts,
        // where the parser can be called directly. Kept here as regression
        // pinning, not as evidence.
        it('a blank retry-after is undefined, never NaN and never 0', async () => {
            for (const blank of ['', '   ']) {
                mockFetch.mockResolvedValueOnce(
                    jsonResponse({ error: 'slow down' }, 429, {
                        'retry-after': blank,
                    }),
                );
                const err = await client.listSources().catch((e) => e);
                expect(err).toBeInstanceOf(JulesRateLimitError);
                expect(err.retryAfter).toBeUndefined();
                expect(Number.isNaN(err.retryAfter)).toBe(false);
            }
        });

        it('an unparseable retry-after is undefined rather than NaN', async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ error: 'slow down' }, 429, {
                    'retry-after': 'soon',
                }),
            );
            const err = await client.listSources().catch((e) => e);
            expect(err.retryAfter).toBeUndefined();
        });

        it("retry-after '0' survives as a legitimate 0", async () => {
            mockFetch.mockResolvedValueOnce(
                jsonResponse({ error: 'slow down' }, 429, {
                    'retry-after': '0',
                }),
            );
            const err = await client.listSources().catch((e) => e);
            expect(err.retryAfter).toBe(0);
        });
    });
});

describe('request timeout (B1-118)', () => {
    it('defaults to a 30s AbortSignal timeout', async () => {
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
        mockFetch.mockResolvedValueOnce(jsonResponse({ sources: [] }));

        const client = new JulesClient('test-api-key');
        await client.listSources();

        expect(timeoutSpy).toHaveBeenCalledWith(30_000);
        timeoutSpy.mockRestore();
    });

    it('honors a per-client requestTimeoutMs override', async () => {
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
        mockFetch.mockResolvedValueOnce(jsonResponse({ sources: [] }));

        const client = new JulesClient('test-api-key', {
            requestTimeoutMs: 120_000,
        });
        await client.listSources();

        expect(timeoutSpy).toHaveBeenCalledWith(120_000);
        timeoutSpy.mockRestore();
    });
});

// --- Retry (#50643, consolidating #50416 / #50447 / #50451 / #50461) ---
//
// The pure policy is covered in tests/retry.test.ts. These assert the CLIENT
// actually routes through it: that the method reaching planRetry is the real
// one, that the sleep really happens, and that an exhausted retry still maps to
// the same typed error the non-retrying client produced.
//
// The discriminating pair is (429, POST) retried and (503, POST) not. A client
// that passed a hardcoded 'GET' to the policy would retry both and pass every
// other assertion here.

describe('JulesClient retry', () => {
    let slept: number[];
    const retrying = (retries = 2) =>
        new JulesClient('test-api-key', {
            retries,
            retryBaseDelayMs: 100,
            retryJitterMs: 0,
            random: () => 0,
            sleep: async (ms: number) => {
                slept.push(ms);
            },
        });

    beforeEach(() => {
        vi.resetAllMocks();
        slept = [];
    });

    it('retries a 429 on POST /sessions — rejected means not processed', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429))
            .mockResolvedValueOnce(jsonResponse({ name: 'sessions/1' }));

        const session = await retrying().createSession({
            prompt: 'p',
            sourceContext: { source: 'sources/github/o/r' },
        });

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(session.name).toBe('sessions/1');
    });

    it('does NOT retry a 503 on POST /sessions — it may already exist', async () => {
        mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 503));

        await expect(
            retrying().createSession({
                prompt: 'p',
                sourceContext: { source: 'sources/github/o/r' },
            }),
        ).rejects.toThrow();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('retries a 503 on GET', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
            .mockResolvedValueOnce(jsonResponse({ name: 'sessions/1' }));

        const session = await retrying().getSession('sessions/1');

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(session.name).toBe('sessions/1');
    });

    it('sleeps between attempts, backing off exponentially', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
            .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
            .mockResolvedValueOnce(jsonResponse({ name: 'sessions/1' }));

        await retrying().getSession('sessions/1');

        expect(slept).toEqual([100, 200]);
    });

    it('honors Retry-After for the sleep duration', async () => {
        mockFetch
            .mockResolvedValueOnce(
                jsonResponse({ error: 'slow down' }, 429, {
                    'retry-after': '4',
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ name: 'sessions/1' }));

        await retrying().getSession('sessions/1');

        expect(slept).toEqual([4000]);
    });

    it('throws the mapped error once the budget is spent', async () => {
        mockFetch.mockResolvedValue(
            jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '2' }),
        );

        const err = await retrying(2)
            .getSession('sessions/1')
            .catch((e) => e);

        expect(err).toBeInstanceOf(JulesRateLimitError);
        expect(err.retryAfter).toBe(2);
        expect(mockFetch).toHaveBeenCalledTimes(3); // 1 + 2 retries
    });

    it('retries a network error on GET but not on POST', async () => {
        mockFetch
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(jsonResponse({ name: 'sessions/1' }));
        await retrying().getSession('sessions/1');
        expect(mockFetch).toHaveBeenCalledTimes(2);

        vi.resetAllMocks();
        mockFetch.mockRejectedValue(new TypeError('fetch failed'));
        await expect(
            retrying().createSession({
                prompt: 'p',
                sourceContext: { source: 'sources/github/o/r' },
            }),
        ).rejects.toThrow();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('never retries a timeout, even on GET', async () => {
        mockFetch.mockRejectedValue(
            new DOMException('timed out', 'TimeoutError'),
        );

        await expect(retrying().getSession('sessions/1')).rejects.toThrow();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(slept).toEqual([]);
    });

    // The discriminating one: a runtime that reports the deadline as a
    // TypeError makes the request look like BOTH a timeout and a retryable
    // network failure on an idempotent method. Timeout has to win. Without
    // this the timeout rule is dead code — a bare timeout is already
    // unretryable for want of any retryable signal.
    it('never retries a timeout surfaced as a TypeError', async () => {
        const err = new TypeError('fetch failed');
        err.name = 'TimeoutError';
        mockFetch.mockRejectedValue(err);

        await expect(retrying().getSession('sessions/1')).rejects.toThrow();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(slept).toEqual([]);
    });

    // An AbortSignal.timeout that has already fired stays aborted forever, so
    // a signal hoisted out of the retry loop would make attempt 2 abort on the
    // spot. A mocked fetch ignores the signal, so nothing else in this file
    // would notice.
    it('gives each attempt a fresh timeout signal', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
            .mockResolvedValueOnce(jsonResponse({ name: 'sessions/1' }));

        await retrying().getSession('sessions/1');

        const first = mockFetch.mock.calls[0][1].signal;
        const second = mockFetch.mock.calls[1][1].signal;
        expect(first).toBeInstanceOf(AbortSignal);
        expect(second).toBeInstanceOf(AbortSignal);
        expect(second).not.toBe(first);
    });

    it('defaults to retrying, so callers get it without opting in', async () => {
        mockFetch
            .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
            .mockResolvedValueOnce(jsonResponse({ name: 'sessions/1' }));

        const client = new JulesClient('test-api-key', {
            retryBaseDelayMs: 0,
            retryJitterMs: 0,
        });
        const session = await client.getSession('sessions/1');

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(session.name).toBe('sessions/1');
    });

    it('retries: 0 disables it entirely', async () => {
        mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 503));
        await expect(retrying(0).getSession('sessions/1')).rejects.toThrow();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});
