import {
    JulesAPIError,
    JulesAuthError,
    JulesNotFoundError,
    JulesRateLimitError,
} from './errors.js';
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

    constructor(apiKey: string, opts?: { requestTimeoutMs?: number }) {
        this.apiKey = apiKey;
        this.requestTimeoutMs =
            opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }

    private async request<T>(
        path: string,
        method: 'GET' | 'POST' | 'DELETE' = 'GET',
        body?: unknown,
        timeoutMs?: number,
    ): Promise<T> {
        const url = `${BASE_URL}${path}`;
        const headers: Record<string, string> = {
            'X-Goog-Api-Key': this.apiKey,
        };

        const init: RequestInit = {
            method,
            headers,
            signal: AbortSignal.timeout(timeoutMs ?? this.requestTimeoutMs),
        };

        if (body) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        const response = await fetch(url, init);

        if (!response.ok) {
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
            const retryAfter = response.headers.get('retry-after');
            throw new JulesRateLimitError(
                retryAfter ? parseInt(retryAfter, 10) : undefined,
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
