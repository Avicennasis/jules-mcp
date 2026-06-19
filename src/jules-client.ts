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
    normalizeResourceName,
} from './types.js';

const BASE_URL = 'https://jules.googleapis.com/v1alpha';

export interface CreateSessionRequest {
    prompt: string;
    sourceContext: SourceContext;
    title?: string;
    requirePlanApproval?: boolean;
    automationMode?: AutomationMode;
}

export class JulesClient {
    private readonly apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    private async request<T>(
        path: string,
        method: 'GET' | 'POST' | 'DELETE' = 'GET',
        body?: unknown,
    ): Promise<T> {
        const url = `${BASE_URL}${path}`;
        const headers: Record<string, string> = {
            'X-Goog-Api-Key': this.apiKey,
        };

        const init: RequestInit = {
            method,
            headers,
            signal: AbortSignal.timeout(30000),
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

        return (await response.json()) as T;
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

    async listSources(): Promise<Source[]> {
        const result = await this.request<{ sources?: Source[] }>('/sources');
        return result.sources ?? [];
    }

    async getSource(name: string): Promise<Source> {
        const normalized = normalizeResourceName(name, 'sources');
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
        const name = normalizeResourceName(sessionId, 'sessions');
        return this.request<Session>(`/${name}`);
    }

    async approvePlan(sessionId: string): Promise<Session> {
        const name = normalizeResourceName(sessionId, 'sessions');
        return this.request<Session>(`/${name}:approvePlan`, 'POST', {});
    }

    async sendMessage(sessionId: string, message: string): Promise<Session> {
        const name = normalizeResourceName(sessionId, 'sessions');
        // The Jules API expects the text under "prompt" (same field as session
        // creation), not "message".
        return this.request<Session>(`/${name}:sendMessage`, 'POST', {
            prompt: message,
        });
    }

    async archiveSession(sessionId: string): Promise<Session> {
        const name = normalizeResourceName(sessionId, 'sessions');
        return this.request<Session>(`/${name}:archive`, 'POST', {});
    }

    async unarchiveSession(sessionId: string): Promise<Session> {
        const name = normalizeResourceName(sessionId, 'sessions');
        return this.request<Session>(`/${name}:unarchive`, 'POST', {});
    }

    async deleteSession(sessionId: string): Promise<void> {
        const name = normalizeResourceName(sessionId, 'sessions');
        await this.request<void>(`/${name}`, 'DELETE');
    }

    // --- Activities ---

    async listActivities(
        sessionId: string,
        pageSize?: number,
        pageToken?: string,
    ): Promise<{ activities: Activity[]; nextPageToken?: string }> {
        const name = normalizeResourceName(sessionId, 'sessions');
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
        const sessionName = normalizeResourceName(sessionId, 'sessions');
        return this.request<Activity>(
            `/${sessionName}/activities/${activityId}`,
        );
    }
}
