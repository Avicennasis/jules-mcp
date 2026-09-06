import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    parseRepo,
    resolveGithubToken,
    fetchIssue,
    GitHubError,
} from '../src/github.js';

function jsonResponse(
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: {
            'content-type': 'application/json',
            ...(init.headers ?? {}),
        },
    });
}

const issuePayload = {
    number: 7,
    title: 'Crash on empty input',
    body: 'Steps to reproduce:\n\n```js\nfoo("")\n```',
    state: 'open',
    html_url: 'https://github.com/o/r/issues/7',
    user: { login: 'reporter' },
    labels: [{ name: 'bug' }, { name: 'p1' }],
    comments: 0,
};

describe('parseRepo', () => {
    it('accepts a plain owner/repo', () => {
        expect(parseRepo('Avicennasis/jules-mcp')).toEqual({
            owner: 'Avicennasis',
            repo: 'jules-mcp',
        });
    });

    it('accepts the dots, dashes and underscores GitHub allows', () => {
        expect(parseRepo('some-org/my_repo.js')).toEqual({
            owner: 'some-org',
            repo: 'my_repo.js',
        });
    });

    // The same class of bug as #50421: this value is interpolated into an API
    // URL path, so a segment that resolves upward addresses a different
    // endpoint entirely. Rejecting is the only safe answer -- percent-encoding
    // '..' leaves it unchanged.
    it.each([
        ['traversal in the owner', '../o/r'],
        ['traversal in the repo', 'o/..'],
        ['a bare dot segment', 'o/.'],
        ['three segments', 'o/r/extra'],
        ['one segment', 'justrepo'],
        ['an empty owner', '/r'],
        ['an empty repo', 'o/'],
        ['an embedded slash escape', 'o/r%2f..'],
        ['a query string', 'o/r?x=1'],
        ['whitespace', 'o/ r'],
        ['the empty string', ''],
    ])('rejects %s', (_label, value) => {
        expect(() => parseRepo(value)).toThrow(GitHubError);
    });
});

describe('resolveGithubToken', () => {
    it('prefers GITHUB_TOKEN', () => {
        expect(
            resolveGithubToken({
                GITHUB_TOKEN: 'a',
                GH_TOKEN: 'b',
                GITHUB_PERSONAL_ACCESS_TOKEN: 'c',
            }),
        ).toBe('a');
    });

    it('falls back to GH_TOKEN then GITHUB_PERSONAL_ACCESS_TOKEN', () => {
        expect(
            resolveGithubToken({
                GH_TOKEN: 'b',
                GITHUB_PERSONAL_ACCESS_TOKEN: 'c',
            }),
        ).toBe('b');
        expect(resolveGithubToken({ GITHUB_PERSONAL_ACCESS_TOKEN: 'c' })).toBe(
            'c',
        );
    });

    // An exported-but-empty variable is the shape a sourced secrets file
    // produces when a lookup failed. Treating '' as a token would send
    // `Authorization: Bearer ` and turn a public-repo read into a 401.
    it('treats an empty or blank value as absent', () => {
        expect(resolveGithubToken({ GITHUB_TOKEN: '   ' })).toBeUndefined();
        expect(resolveGithubToken({})).toBeUndefined();
    });
});

describe('fetchIssue', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('requests the issue from the REST API and maps its fields', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(issuePayload));

        const issue = await fetchIssue('o/r', 7, { includeComments: false });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://api.github.com/repos/o/r/issues/7',
        );
        expect(issue).toMatchObject({
            repo: 'o/r',
            number: 7,
            title: 'Crash on empty input',
            author: 'reporter',
            labels: ['bug', 'p1'],
            htmlUrl: 'https://github.com/o/r/issues/7',
        });
        expect(issue.body).toContain('foo("")');
        expect(issue.comments).toEqual([]);
    });

    it('sends an Authorization header only when a token is supplied', async () => {
        // A Response body reads once, so each call needs its own object --
        // mockResolvedValue would hand the same one back twice.
        fetchMock.mockImplementation(async () => jsonResponse(issuePayload));

        await fetchIssue('o/r', 7, { includeComments: false });
        const anon = (fetchMock.mock.calls[0][1] as RequestInit)
            .headers as Record<string, string>;
        expect(anon.Authorization).toBeUndefined();
        expect(anon.Accept).toBe('application/vnd.github+json');

        await fetchIssue('o/r', 7, { includeComments: false, token: 'tok' });
        const authed = (fetchMock.mock.calls[1][1] as RequestInit)
            .headers as Record<string, string>;
        expect(authed.Authorization).toBe('Bearer tok');
    });

    // proto3-style absence is a Jules quirk, but GitHub has its own: an issue
    // filed with no description serializes `body` as JSON null, not "".
    it('normalizes a null body to the empty string', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ ...issuePayload, body: null }),
        );
        const issue = await fetchIssue('o/r', 7, { includeComments: false });
        expect(issue.body).toBe('');
    });

    it('accepts labels given as bare strings as well as objects', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ ...issuePayload, labels: ['bug', { name: 'p1' }] }),
        );
        const issue = await fetchIssue('o/r', 7, { includeComments: false });
        expect(issue.labels).toEqual(['bug', 'p1']);
    });

    it('pages through 200 comments and keeps them in order', async () => {
        const page = (from: number, n: number) =>
            Array.from({ length: n }, (_, i) => ({
                user: { login: `u${from + i}` },
                body: `comment ${from + i}`,
                created_at: '2026-01-01T00:00:00Z',
            }));

        fetchMock
            .mockResolvedValueOnce(
                jsonResponse({ ...issuePayload, comments: 200 }),
            )
            .mockResolvedValueOnce(jsonResponse(page(0, 100)))
            .mockResolvedValueOnce(jsonResponse(page(100, 100)))
            .mockResolvedValueOnce(jsonResponse([]));

        const issue = await fetchIssue('o/r', 7, { maxComments: 500 });

        expect(issue.comments).toHaveLength(200);
        expect(issue.comments[0].body).toBe('comment 0');
        expect(issue.comments[199].body).toBe('comment 199');
        expect(issue.commentsTruncated).toBe(false);
        expect(fetchMock.mock.calls[1][0]).toBe(
            'https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=1',
        );
        expect(fetchMock.mock.calls[2][0]).toBe(
            'https://api.github.com/repos/o/r/issues/7/comments?per_page=100&page=2',
        );
        // 1 issue + 2 full pages + 1 empty probe. A page that comes back full
        // could always have a successor, so the empty page is how the walk
        // learns it is done.
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('stops on a short final page without probing for another', async () => {
        const page = (from: number, n: number) =>
            Array.from({ length: n }, (_, i) => ({
                user: { login: `u${from + i}` },
                body: `comment ${from + i}`,
            }));

        fetchMock
            .mockResolvedValueOnce(
                jsonResponse({ ...issuePayload, comments: 150 }),
            )
            .mockResolvedValueOnce(jsonResponse(page(0, 100)))
            .mockResolvedValueOnce(jsonResponse(page(100, 50)));

        const issue = await fetchIssue('o/r', 7, { maxComments: 500 });

        expect(issue.comments).toHaveLength(150);
        expect(issue.commentsTruncated).toBe(false);
        // A short page IS the last page. Without that shortcut every issue
        // with a partial final page costs an extra round trip, and this is the
        // only assertion that can tell -- the empty-page break hides it.
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    // src/pagination.ts's lesson applied here: a paginating loop fails
    // unboundedly rather than loudly, so it needs more than one termination.
    // max_comments and the short/empty page cover every well-behaved server;
    // this covers the one that answers with a full page forever.
    it('stops at the page cap when no page is ever short', async () => {
        fetchMock.mockImplementation(async (url: string) =>
            String(url).includes('/comments')
                ? jsonResponse(
                      Array.from({ length: 100 }, (_, i) => ({
                          user: { login: 'u' },
                          body: `c${i}`,
                      })),
                  )
                : jsonResponse({ ...issuePayload, comments: 100000 }),
        );

        const issue = await fetchIssue('o/r', 7, { maxComments: 100000 });

        // 20 pages of 100, plus the issue itself. Without the cap this call
        // never returns.
        expect(issue.comments).toHaveLength(2000);
        expect(fetchMock).toHaveBeenCalledTimes(21);
        expect(issue.commentsTruncated).toBe(true);
    });

    it('stops at max_comments and reports the result as truncated', async () => {
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse({ ...issuePayload, comments: 200 }),
            )
            .mockResolvedValueOnce(
                jsonResponse(
                    Array.from({ length: 100 }, (_, i) => ({
                        user: { login: 'u' },
                        body: `c${i}`,
                    })),
                ),
            );

        const issue = await fetchIssue('o/r', 7, { maxComments: 5 });

        expect(issue.comments).toHaveLength(5);
        expect(issue.commentsTruncated).toBe(true);
        expect(issue.commentsTotal).toBe(200);
        // per_page is clamped to what is still wanted, so a max_comments of 5
        // costs one 5-row page rather than a 100-row one.
        expect(fetchMock.mock.calls[1][0]).toContain('per_page=5');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('makes no comments request when include_comments is false', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ ...issuePayload, comments: 12 }),
        );
        const issue = await fetchIssue('o/r', 7, { includeComments: false });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(issue.comments).toEqual([]);
        // 12 exist and none were fetched -- that is a truncation, and saying
        // otherwise would let the prompt claim it saw the whole thread.
        expect(issue.commentsTruncated).toBe(true);
    });

    // GitHub answers 404 for a repo you cannot see, deliberately, so a private
    // repo and a nonexistent issue are indistinguishable from the outside. The
    // error has to say so or every private-repo failure reads as a typo.
    it('maps 404 to a GitHubError naming the private-repo ambiguity', async () => {
        fetchMock.mockImplementation(async () =>
            jsonResponse({ message: 'Not Found' }, { status: 404 }),
        );
        await expect(fetchIssue('o/r', 7)).rejects.toMatchObject({
            name: 'GitHubError',
            statusCode: 404,
            // The remedy belongs in `hint`, matching JulesAPIError's split
            // between what happened and what to do about it.
            hint: expect.stringMatching(/private/i),
        });
    });

    it('maps 401 to an auth error mentioning the token variables', async () => {
        fetchMock.mockImplementation(async () =>
            jsonResponse({ message: 'Bad credentials' }, { status: 401 }),
        );
        await expect(
            fetchIssue('o/r', 7, { token: 'bad' }),
        ).rejects.toMatchObject({
            statusCode: 401,
            hint: expect.stringContaining('GITHUB_TOKEN'),
        });
    });

    // Both cases arrive as status 403 and the branch that tells them apart is
    // ours. Asserting on the message does NOT test it: GitHub's own message for
    // the rate-limited case already contains the words "rate limit", so a
    // message assertion passes with our branch deleted -- it tests GitHub's
    // wording. The `hint` is the half we write, and the two hints give opposite
    // remedies: wait, versus authenticate.
    it('distinguishes an exhausted rate limit from a plain 403', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                { message: 'API rate limit exceeded' },
                { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
            ),
        );
        await expect(fetchIssue('o/r', 7)).rejects.toMatchObject({
            statusCode: 403,
            hint: expect.stringContaining('60/hour'),
        });

        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                { message: 'Forbidden' },
                { status: 403, headers: { 'x-ratelimit-remaining': '4999' } },
            ),
        );
        // Same status, opposite remedy: "wait" versus "authenticate".
        await expect(fetchIssue('o/r', 7)).rejects.toMatchObject({
            statusCode: 403,
            hint: expect.stringContaining('scope'),
        });
    });

    it('surfaces the GitHub message on an unexpected status', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ message: 'Service unavailable' }, { status: 503 }),
        );
        await expect(fetchIssue('o/r', 7)).rejects.toMatchObject({
            statusCode: 503,
            message: expect.stringContaining('Service unavailable'),
        });
    });

    it('rejects a malformed repo before making any request', async () => {
        await expect(fetchIssue('o/../../x', 7)).rejects.toThrow(GitHubError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a non-integer or non-positive issue number', async () => {
        await expect(fetchIssue('o/r', 0)).rejects.toThrow(GitHubError);
        await expect(fetchIssue('o/r', -1)).rejects.toThrow(GitHubError);
        await expect(fetchIssue('o/r', 1.5)).rejects.toThrow(GitHubError);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
