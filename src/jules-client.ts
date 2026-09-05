import {
    JulesAPIError,
    JulesAuthError,
    JulesNotFoundError,
    JulesRateLimitError,
} from './errors.js';
import { parseRetryAfterSeconds } from './retry-after.js';
import { planRetry } from './retry.js';
import {
    type Session,
    type Source,
    type Activity,
    type SourceContext,
    type AutomationMode,
    encodeResourceName,
} from './types.js';

const BASE_URL = 'https://jules.googleapis.com/v1alpha';

/** Default per-request timeout (ms). Override per client via the
 * constructor `requestTimeoutMs` option, or per call via the request()
 * `timeoutMs` parameter (B1-118). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Retries per request, on top of the first attempt. See src/retry.ts for the
 * policy: a 429 replays for any method, a 5xx or network failure only for
 * idempotent ones (#50643). */
const DEFAULT_RETRIES = 2;

/** Real sleep. Injectable via the constructor so tests need no fake timers. */
const realSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

export interface JulesClientOptions {
    requestTimeoutMs?: number;
    /** Retries per request. `0` disables retrying. */
    retries?: number;
    retryBaseDelayMs?: number;
    retryJitterMs?: number;
    retryMaxDelayMs?: number;
    /** Jitter source; injectable for deterministic tests. */
    random?: () => number;
    /** Sleep between attempts; injectable for deterministic tests. */
    sleep?: (ms: number) => Promise<void>;
}

export interface CreateSessionRequest {
    prompt: string;
    sourceContext: SourceContext;
    title?: string;
    requirePlanApproval?: boolean;
    automationMode?: AutomationMode;
}

export class JulesClient {
    private readonly apiKey: string;
    private readonly requestTimeoutMs: number;
    private readonly retries: number;
    private readonly retryTuning: {
        baseDelayMs?: number;
        jitterMs?: number;
        maxDelayMs?: number;
        random?: () => number;
    };
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(apiKey: string, opts?: JulesClientOptions) {
        this.apiKey = apiKey;
        this.requestTimeoutMs =
            opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.retries = opts?.retries ?? DEFAULT_RETRIES;
        this.retryTuning = {
            baseDelayMs: opts?.retryBaseDelayMs,
            jitterMs: opts?.retryJitterMs,
            maxDelayMs: opts?.retryMaxDelayMs,
            random: opts?.random,
        };
        this.sleep = opts?.sleep ?? realSleep;
    }

    private async request<T>(
        path: string,
        method: 'GET' | 'POST' | 'DELETE' = 'GET',
        body?: unknown,
        timeoutMs?: number,
    ): Promise<T> {
        const url = `${BASE_URL}${path}`;

        // A fresh timeout signal per attempt: an AbortSignal.timeout that has
        // already fired stays aborted, so reusing one would make every retry
        // abort instantly.
        for (let attempt = 0; ; attempt++) {
            const headers: Record<string, string> = {
                'X-Goog-Api-Key': this.apiKey,
            };
            const timeoutSignal = AbortSignal.timeout(
                timeoutMs ?? this.requestTimeoutMs,
            );
            const init: RequestInit = {
                method,
                headers,
                signal: timeoutSignal,
            };

            if (body) {
                headers['Content-Type'] = 'application/json';
                init.body = JSON.stringify(body);
            }

            let response: Response;
            try {
                response = await fetch(url, init);
            } catch (err) {
                // A timeout is our own deadline, not the server's advice, and
                // is never retried. Anything else that throws out of fetch is a
                // transport failure — ambiguous, so idempotent methods only.
                const timeout =
                    timeoutSignal.aborted ||
                    (err as Error | undefined)?.name === 'TimeoutError';
                const plan = planRetry({
                    method,
                    timeout,
                    networkError: err instanceof TypeError,
                    attempt,
                    maxRetries: this.retries,
                    ...this.retryTuning,
                });
                if (!plan.retry) throw err;
                await this.sleep(plan.delayMs);
                continue;
            }

            if (!response.ok) {
                const plan = planRetry({
                    method,
                    status: response.status,
                    retryAfterSeconds: parseRetryAfterSeconds(
                        response.headers.get('retry-after'),
                    ),
                    attempt,
                    maxRetries: this.retries,
                    ...this.retryTuning,
                });
                if (plan.retry) {
                    await this.sleep(plan.delayMs);
                    continue;
                }
                await this.handleError(response, path);
            }

            // DELETE returns google.protobuf.Empty — the body may be `{}` or empty.
            if (method === 'DELETE') {
                return undefined as T;
            }

            // `:sendMessage` also returns google.protobuf.Empty, and a completely
            // empty body is not parseable JSON. Parsing it threw AFTER the request
            // had already succeeded, which surfaced to callers as a failed call for
            // an action that actually happened (#30). Treat an empty body as an
            // empty result rather than an error.
            const text = await response.text();
            if (text.trim() === '') {
                return undefined as T;
            }
            return JSON.parse(text) as T;
        }
    }

    private async handleError(
        response: Response,
        path: string,
    ): Promise<never> {
        const status = response.status;

        if (status === 401 || status === 403) {
            throw new JulesAuthError();
        }

        if (status === 404) {
            throw new JulesNotFoundError(path);
        }

        if (status === 429) {
            // parseRetryAfterSeconds, not parseInt: a blank header must mean
            // "no advice" (undefined), never 0 and never NaN. See
            // src/retry-after.ts for why the NaN was the live hazard (#50648).
            throw new JulesRateLimitError(
                parseRetryAfterSeconds(response.headers.get('retry-after')),
            );
        }

        let message = `Jules API error: ${status}`;
        try {
            const body = await response.json();
            if (body?.error?.message) {
                message = body.error.message;
            }
        } catch {
            // Use default message
        }

        throw new JulesAPIError(message, status);
    }

    // --- Sources ---

    async listSources(opts?: {
        pageSize?: number;
        pageToken?: string;
        filter?: string;
    }): Promise<{ sources: Source[]; nextPageToken?: string }> {
        const params = new URLSearchParams();
        if (opts?.pageSize) params.set('pageSize', String(opts.pageSize));
        if (opts?.pageToken) params.set('pageToken', opts.pageToken);
        if (opts?.filter) params.set('filter', opts.filter);
        const query = params.toString();
        const path = query ? `/sources?${query}` : '/sources';
        const result = await this.request<{
            sources?: Source[];
            nextPageToken?: string;
        }>(path);
        return {
            sources: result.sources ?? [],
            nextPageToken: result.nextPageToken,
        };
    }

    async getSource(name: string): Promise<Source> {
        const normalized = encodeResourceName(name, 'sources');
        return this.request<Source>(`/${normalized}`);
    }

    // --- Sessions ---

    async createSession(body: CreateSessionRequest): Promise<Session> {
        return this.request<Session>('/sessions', 'POST', body);
    }

    async listSessions(
        pageSize?: number,
        pageToken?: string,
    ): Promise<{ sessions: Session[]; nextPageToken?: string }> {
        const params = new URLSearchParams();
        if (pageSize) params.set('pageSize', String(pageSize));
        if (pageToken) params.set('pageToken', pageToken);
        const query = params.toString();
        const path = query ? `/sessions?${query}` : '/sessions';
        const result = await this.request<{
            sessions?: Session[];
            nextPageToken?: string;
        }>(path);
        return {
            sessions: result.sessions ?? [],
            nextPageToken: result.nextPageToken,
        };
    }

    async getSession(sessionId: string): Promise<Session> {
        const name = encodeResourceName(sessionId, 'sessions');
        return this.request<Session>(`/${name}`);
    }

    async approvePlan(sessionId: string): Promise<Session> {
        const name = encodeResourceName(sessionId, 'sessions');
        return this.request<Session>(`/${name}:approvePlan`, 'POST', {});
    }

    /**
     * Send a message to a session.
     *
     * Returns `undefined` (or a payload without session fields) on success —
     * the endpoint returns google.protobuf.Empty, so callers must NOT assume a
     * populated Session comes back. Re-read the session if you need its state.
     */
    async sendMessage(
        sessionId: string,
        message: string,
    ): Promise<Session | undefined> {
        const name = encodeResourceName(sessionId, 'sessions');
        // The Jules API expects the text under "prompt" (same field as session
        // creation), not "message".
        return this.request<Session | undefined>(
            `/${name}:sendMessage`,
            'POST',
            { prompt: message },
        );
    }

    async archiveSession(sessionId: string): Promise<Session> {
        const name = encodeResourceName(sessionId, 'sessions');
        return this.request<Session>(`/${name}:archive`, 'POST', {});
    }

    async unarchiveSession(sessionId: string): Promise<Session> {
        const name = encodeResourceName(sessionId, 'sessions');
        return this.request<Session>(`/${name}:unarchive`, 'POST', {});
    }

    async deleteSession(sessionId: string): Promise<void> {
        const name = encodeResourceName(sessionId, 'sessions');
        await this.request<void>(`/${name}`, 'DELETE');
    }

    // --- Activities ---

    async listActivities(
        sessionId: string,
        pageSize?: number,
        pageToken?: string,
    ): Promise<{ activities: Activity[]; nextPageToken?: string }> {
        const name = encodeResourceName(sessionId, 'sessions');
        const params = new URLSearchParams();
        if (pageSize) params.set('pageSize', String(pageSize));
        if (pageToken) params.set('pageToken', pageToken);
        const query = params.toString();
        const path = query
            ? `/${name}/activities?${query}`
            : `/${name}/activities`;
        const result = await this.request<{
            activities?: Activity[];
            nextPageToken?: string;
        }>(path);
        return {
            activities: result.activities ?? [],
            nextPageToken: result.nextPageToken,
        };
    }

    async getActivity(
        sessionId: string,
        activityId: string,
    ): Promise<Activity> {
        const sessionName = encodeResourceName(sessionId, 'sessions');
        // activityId is interpolated into the path too, so it needs the same
        // treatment -- encoded as a single segment (#50421).
        const encodedActivityId = encodeURIComponent(activityId);
        if (activityId === '' || activityId === '.' || activityId === '..') {
            throw new Error(
                `Invalid activity id ${JSON.stringify(activityId)}.`,
            );
        }
        return this.request<Activity>(
            `/${sessionName}/activities/${encodedActivityId}`,
        );
    }
}
