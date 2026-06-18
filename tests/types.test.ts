import { describe, it, expect } from 'vitest';
import { normalizeResourceName, TERMINAL_STATES } from '../src/types.js';

describe('normalizeResourceName', () => {
  it('prefixes a bare ID', () => {
    expect(normalizeResourceName('abc123', 'sessions')).toBe('sessions/abc123');
  });

  it('passes through an already-prefixed name', () => {
    expect(normalizeResourceName('sessions/abc123', 'sessions')).toBe('sessions/abc123');
  });

  it('handles sources with nested paths', () => {
    expect(normalizeResourceName('github/owner/repo', 'sources')).toBe('sources/github/owner/repo');
  });

  it('passes through sources already prefixed', () => {
    expect(normalizeResourceName('sources/github/owner/repo', 'sources')).toBe('sources/github/owner/repo');
  });
});

describe('TERMINAL_STATES', () => {
  it('contains COMPLETED and FAILED', () => {
    expect(TERMINAL_STATES.has('COMPLETED')).toBe(true);
    expect(TERMINAL_STATES.has('FAILED')).toBe(true);
  });

  it('does not contain IN_PROGRESS', () => {
    expect(TERMINAL_STATES.has('IN_PROGRESS')).toBe(false);
  });
});
