export class JulesAPIError extends Error {
    public readonly statusCode: number;
    public readonly hint?: string;

    constructor(message: string, statusCode: number, hint?: string) {
        super(message);
        this.name = 'JulesAPIError';
        this.statusCode = statusCode;
        this.hint = hint;
    }

    toJSON(): { status: string; message: string; code: number } {
        return {
            status: 'ERROR',
            message: this.message,
            code: this.statusCode,
        };
    }
}

export class JulesAuthError extends JulesAPIError {
    constructor(message?: string) {
        super(
            message ?? 'Authentication failed',
            401,
            'Check your JULES_API_KEY — is it a valid API key? Has it expired or been disabled? Generate keys at jules.google/settings.',
        );
        this.name = 'JulesAuthError';
    }
}

export class JulesNotFoundError extends JulesAPIError {
    constructor(resourceName: string) {
        super(
            `Resource not found: ${resourceName}`,
            404,
            `The resource "${resourceName}" does not exist or you do not have access.`,
        );
        this.name = 'JulesNotFoundError';
    }
}

export class JulesRateLimitError extends JulesAPIError {
    public readonly retryAfter?: number;

    constructor(retryAfter?: number) {
        const hint = retryAfter
            ? `Rate limited. Retry after ${retryAfter} seconds.`
            : 'Rate limited. Try again later.';
        super('Rate limit exceeded', 429, hint);
        this.name = 'JulesRateLimitError';
        this.retryAfter = retryAfter;
    }
}

export class JulesStateError extends JulesAPIError {
    constructor(action: string, currentState: string) {
        super(
            `Cannot perform "${action}" — session is currently in state "${currentState}"`,
            409,
            `The session must be in an appropriate state for this action. Current state: ${currentState}.`,
        );
        this.name = 'JulesStateError';
    }
}
