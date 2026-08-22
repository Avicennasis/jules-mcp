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
