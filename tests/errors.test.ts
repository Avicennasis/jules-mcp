import { describe, it, expect } from 'vitest';
import {
  JulesAPIError,
  JulesAuthError,
  JulesNotFoundError,
  JulesRateLimitError,
  JulesStateError,
} from '../src/errors.js';

describe('JulesAPIError', () => {
  it('stores message, statusCode, and hint', () => {
    const err = new JulesAPIError('something broke', 500, 'try again');
    expect(err.message).toBe('something broke');
    expect(err.statusCode).toBe(500);
    expect(err.hint).toBe('try again');
    expect(err).toBeInstanceOf(Error);
  });

  it('toJSON returns structured error shape', () => {
    const err = new JulesAPIError('bad', 400);
    expect(err.toJSON()).toEqual({
      status: 'ERROR',
      message: 'bad',
      code: 400,
    });
  });
});

describe('JulesAuthError', () => {
  it('defaults to 401 with auth hint', () => {
    const err = new JulesAuthError();
    expect(err.statusCode).toBe(401);
    expect(err.hint).toContain('API key');
    expect(err).toBeInstanceOf(JulesAPIError);
  });
});

describe('JulesNotFoundError', () => {
  it('includes the resource ID in the message', () => {
    const err = new JulesNotFoundError('sessions/abc123');
    expect(err.message).toContain('abc123');
    expect(err.statusCode).toBe(404);
  });
});

describe('JulesRateLimitError', () => {
  it('includes retryAfter when provided', () => {
    const err = new JulesRateLimitError(30);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfter).toBe(30);
    expect(err.hint).toContain('30');
  });
});

describe('JulesStateError', () => {
  it('explains current state and valid actions', () => {
    const err = new JulesStateError('approve_plan', 'IN_PROGRESS');
    expect(err.message).toContain('approve_plan');
    expect(err.message).toContain('IN_PROGRESS');
    expect(err.statusCode).toBe(409);
  });
});
