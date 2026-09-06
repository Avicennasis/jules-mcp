/**
 * Minimal read-only GitHub REST client — just enough to turn an issue into a
 * Jules task. Redmine #50457.
 *
 * WHY THERE IS NO DEPENDENCY HERE. Three routes were available: Octokit, the
 * `gh` CLI, or the platform `fetch`. `fetch` wins on every axis that matters
 * for an MCP server:
 *
 * - Octokit is a large dependency for four fields off two endpoints, and this
 *   repo has kept its tree deliberately small (SDK, zod, node-cron).
 * - `gh` is a *runtime* dependency on the host's PATH and on `gh auth` state.
 *   An MCP server runs wherever its client runs — a container, a launchd job,
 *   someone else's laptop — and "works on the author's machine" is exactly the
 *   failure this avoids. Worse, shelling out invites passing a token through
 *   argv, and argv is world-readable via /proc/PID/cmdline (B1-116) — the same
 *   hazard `src/audit.ts` already routes around by writing payloads to stdin.
 * - `fetch` is global from Node 18, needs no install, and is stubbed with
 *   `vi.stubGlobal` in tests exactly like `src/jules-client.ts` is.
 *
 * The token is read from the environment only, and never logged, never echoed
 * into a prompt, never placed in argv, and never written to an audit record.
 *
 * SCOPE NOTE. Everything this module returns is attacker-writable on a public
 * repo — a comment especially. Callers must fence it (`src/untrusted.ts`)
 * before it enters a prompt. Nothing here sanitizes; that is deliberate, see
 * the fence's doc comment.
 */

const GITHUB_API = 'https://api.github.com';

/** GitHub's own limit for `per_page` on the comments endpoint. */
const MAX_PER_PAGE = 100;

/** Comments fetched when the caller does not say. */
export const DEFAULT_MAX_COMMENTS = 100;

/** Per-request deadline. GitHub is fast; a slow reply is a stuck one. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Hard ceiling on comment pages, independent of `maxComments`.
 *
 * A paginating loop fails unboundedly rather than loudly (see
 * `src/pagination.ts`), so the page count is bounded by arithmetic here rather
 * than by trusting the server to eventually return a short page.
 */
const MAX_COMMENT_PAGES = 20;

export class GitHubError extends Error {
    public readonly statusCode: number;
    public readonly hint?: string;

    constructor(message: string, statusCode: number, hint?: string) {
        super(message);
        this.name = 'GitHubError';
        this.statusCode = statusCode;
        this.hint = hint;
    }

    toJSON(): { status: string; message: string; code: number; hint?: string } {
        return {
            status: 'ERROR',
            message: this.message,
            code: this.statusCode,
            hint: this.hint,
        };
    }
}

export interface GithubIssueComment {
    /** Comment author's login. Attacker-chosen on a public repo. */
    author: string;
    body: string;
    createdAt?: string;
}

export interface GithubIssue {
    /** `owner/repo`, exactly as requested. */
    repo: string;
    number: number;
    title: string;
    /** Never null — GitHub sends JSON `null` for an issue with no description. */
    body: string;
    state?: string;
    author: string;
    htmlUrl?: string;
    labels: string[];
    comments: GithubIssueComment[];
    /** Total the issue payload reports, which may exceed `comments.length`. */
    commentsTotal?: number;
    /** True when the thread was cut short — by a cap or by not being fetched. */
    commentsTruncated: boolean;
}

export interface FetchIssueOptions {
    token?: string;
    /** Default true. The discussion is usually where the requirement lives. */
    includeComments?: boolean;
    maxComments?: number;
    timeoutMs?: number;
}

/**
 * GitHub's own rules: owners and repository names are drawn from
 * `[A-Za-z0-9._-]`. Anchoring to that set is what makes the value safe to
 * interpolate into a URL path.
 */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Split `owner/repo`, rejecting anything that could address a different
 * endpoint.
 *
 * This is the #50421 lesson applied to a second API: the value lands in a URL
 * PATH, and `encodeURIComponent('..') === '..'`, so encoding alone does not
 * stop traversal. `.` and `..` are rejected outright, as is any character
 * outside GitHub's own name alphabet — which excludes `/`, `%`, `?`, `#` and
 * whitespace by construction.
 */
export function parseRepo(value: string): { owner: string; repo: string } {
    const parts = value.split('/');
    const bad = (why: string) =>
        new GitHubError(
            `Invalid repo ${JSON.stringify(value)}: ${why}. Expected "owner/repo".`,
            400,
        );

    if (parts.length !== 2) throw bad('expected exactly one "/"');
    const [owner, repo] = parts;
    for (const [name, segment] of [
        ['owner', owner],
        ['repo', repo],
    ] as const) {
        if (segment === '') throw bad(`empty ${name}`);
        if (segment === '.' || segment === '..') {
            throw bad(`${name} resolves to a path segment`);
        }
        if (!NAME_PATTERN.test(segment)) {
            throw bad(`${name} contains characters GitHub does not allow`);
        }
    }
    return { owner, repo };
}

/**
 * Find a GitHub token in the environment, in descending order of specificity.
 *
 * `GITHUB_TOKEN` is what the ticket specifies and what CI sets; `GH_TOKEN` is
 * the `gh` CLI's own variable; `GITHUB_PERSONAL_ACCESS_TOKEN` is this fleet's
 * name for it. Absent means unauthenticated, which works for public repos at
 * 60 requests/hour.
 *
 * A whitespace-only value counts as absent: that is the shape a sourced
 * secrets file leaves behind when a lookup failed, and sending
 * `Authorization: Bearer ` turns a working public read into a 401.
 */
export function resolveGithubToken(
    env: NodeJS.ProcessEnv = process.env,
): string | undefined {
    for (const name of [
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'GITHUB_PERSONAL_ACCESS_TOKEN',
    ]) {
        const value = env[name];
        if (value && value.trim() !== '') return value.trim();
    }
    return undefined;
}

function headers(token?: string): Record<string, string> {
    const h: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'jules-mcp',
    };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
}

async function errorFor(
    response: Response,
    context: string,
): Promise<GitHubError> {
    let message = response.statusText || `HTTP ${response.status}`;
    try {
        const parsed = (await response.json()) as { message?: string };
        if (parsed?.message) message = parsed.message;
    } catch {
        // A non-JSON error body is still an error; the status carries it.
    }

    switch (response.status) {
        case 401:
            return new GitHubError(
                `GitHub rejected the credentials for ${context}: ${message}`,
                401,
                'The token in GITHUB_TOKEN / GH_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN is invalid, expired or revoked. Unset it to read a public repo anonymously.',
            );
        case 403:
            // GitHub uses 403 for both "forbidden" and "you have used your
            // hourly budget". `x-ratelimit-remaining: 0` is what tells them
            // apart, and the remedies are opposites — wait, versus authenticate.
            if (response.headers.get('x-ratelimit-remaining') === '0') {
                return new GitHubError(
                    `GitHub rate limit exceeded for ${context}: ${message}`,
                    403,
                    'Unauthenticated requests are capped at 60/hour. Set GITHUB_TOKEN to raise it to 5000/hour, or wait for the window to reset.',
                );
            }
            return new GitHubError(
                `GitHub refused ${context}: ${message}`,
                403,
                'The token lacks the scope for this resource, or the repository has restricted it.',
            );
        case 404:
            return new GitHubError(
                `GitHub returned 404 for ${context}: ${message}`,
                404,
                'GitHub answers 404 rather than 403 for a repository you cannot see, so a private repo and a nonexistent issue look identical here. Check the issue number, and set GITHUB_TOKEN if the repo is private.',
            );
        case 429:
            return new GitHubError(
                `GitHub rate limit exceeded for ${context}: ${message}`,
                429,
                'Retry after the window resets, or authenticate to raise the limit.',
            );
        default:
            return new GitHubError(
                `GitHub request failed for ${context}: ${message}`,
                response.status,
            );
    }
}

async function getJson<T>(
    url: string,
    context: string,
    token: string | undefined,
    timeoutMs: number,
): Promise<T> {
    const response = await fetch(url, {
        method: 'GET',
        headers: headers(token),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw await errorFor(response, context);
    return (await response.json()) as T;
}

interface RawIssue {
    number?: number;
    title?: string;
    body?: string | null;
    state?: string;
    html_url?: string;
    user?: { login?: string };
    labels?: Array<string | { name?: string }>;
    comments?: number;
}

interface RawComment {
    user?: { login?: string };
    body?: string | null;
    created_at?: string;
}

/**
 * Fetch one issue, and by default its whole comment thread.
 *
 * Comments are paged deliberately rather than left at GitHub's 30-row default:
 * an issue with 200 comments would otherwise be silently read as its first 30,
 * and a prompt built from that says "here is the discussion" while omitting
 * most of it. Whatever is left out is reported through `commentsTruncated` so
 * the caller can say so in the part of the prompt it authors.
 */
export async function fetchIssue(
    repo: string,
    issueNumber: number,
    options: FetchIssueOptions = {},
): Promise<GithubIssue> {
    const { owner, repo: name } = parseRepo(repo);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        throw new GitHubError(
            `Invalid issue number ${JSON.stringify(issueNumber)}: expected a positive integer.`,
            400,
        );
    }

    const token = options.token;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const includeComments = options.includeComments !== false;
    const maxComments = Math.max(
        0,
        Math.floor(options.maxComments ?? DEFAULT_MAX_COMMENTS),
    );
    const base = `${GITHUB_API}/repos/${owner}/${name}/issues/${issueNumber}`;
    const context = `${repo}#${issueNumber}`;

    const raw = await getJson<RawIssue>(base, context, token, timeoutMs);

    const labels = (raw.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l?.name ?? '')))
        .filter((l) => l !== '');

    const comments: GithubIssueComment[] = [];
    if (includeComments && maxComments > 0) {
        for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
            const want = maxComments - comments.length;
            if (want <= 0) break;
            const perPage = Math.min(MAX_PER_PAGE, want);
            const batch = await getJson<RawComment[]>(
                `${base}/comments?per_page=${perPage}&page=${page}`,
                `comments on ${context}`,
                token,
                timeoutMs,
            );
            if (!Array.isArray(batch) || batch.length === 0) break;
            // Clamp to what was asked for rather than to what arrived: a
            // server that ignores `per_page` would otherwise blow straight
            // past maxComments, and the cap is the only bound on how much
            // attacker-written text reaches the prompt.
            for (const c of batch.slice(0, want)) {
                comments.push({
                    author: c?.user?.login ?? 'unknown',
                    body: c?.body ?? '',
                    createdAt: c?.created_at,
                });
            }
            // A short page is the last page. Stopping on it also stops the
            // pathological case where a server keeps answering forever.
            if (batch.length < perPage) break;
        }
    }

    const total = raw.comments;
    const truncated =
        typeof total === 'number'
            ? comments.length < total
            : // No total to compare against: the only thing we can honestly
              // call complete is a thread we asked for and did not fill.
              includeComments && comments.length >= maxComments;

    return {
        repo,
        number: raw.number ?? issueNumber,
        title: raw.title ?? '',
        body: raw.body ?? '',
        state: raw.state,
        author: raw.user?.login ?? 'unknown',
        htmlUrl: raw.html_url,
        labels,
        comments,
        commentsTotal: total,
        commentsTruncated: truncated,
    };
}
