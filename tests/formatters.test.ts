import { describe, it, expect } from 'vitest';
import {
  formatSession,
  formatActivity,
  formatPlan,
  describeState,
  truncatePatch,
} from '../src/formatters.js';
import type { Session, Activity, Plan } from '../src/types.js';

describe('describeState', () => {
  it('returns human-readable descriptions', () => {
    expect(describeState('QUEUED')).toBe('Queued — waiting to start');
    expect(describeState('AWAITING_PLAN_APPROVAL')).toContain('plan');
    expect(describeState('COMPLETED')).toContain('Complete');
  });
});

describe('truncatePatch', () => {
  it('returns short patches unchanged', () => {
    const patch = 'line1\nline2\nline3';
    expect(truncatePatch(patch, 50)).toBe(patch);
  });

  it('truncates long patches with a count', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const patch = lines.join('\n');
    const result = truncatePatch(patch, 10);
    expect(result).toContain('line 0');
    expect(result).toContain('line 9');
    expect(result).toContain('90 more lines');
    expect(result.split('\n').length).toBeLessThan(15);
  });
});

describe('formatPlan', () => {
  it('formats steps as numbered list', () => {
    const plan: Plan = {
      id: 'plan-1',
      steps: [
        { id: 's1', index: 0, title: 'Analyze code', description: 'Read the files' },
        { id: 's2', index: 1, title: 'Write fix', description: 'Apply the patch' },
      ],
      createTime: '2026-01-01T00:00:00Z',
    };
    const result = formatPlan(plan);
    expect(result).toContain('1. Analyze code');
    expect(result).toContain('2. Write fix');
    expect(result).toContain('Read the files');
  });
});

describe('formatSession', () => {
  const baseSession: Session = {
    name: 'sessions/abc',
    id: 'abc',
    prompt: 'fix the bug',
    title: 'Bug Fix',
    sourceContext: { source: 'sources/github/o/r' },
    createTime: '2026-01-01T00:00:00Z',
    updateTime: '2026-01-01T01:00:00Z',
    state: 'COMPLETED',
    url: 'https://jules.google/sessions/abc',
    outputs: [{ pullRequest: { url: 'https://github.com/o/r/pull/1', title: 'Fix bug', description: 'Fixes it' } }],
  };

  it('includes state description and PR link', () => {
    const result = formatSession(baseSession);
    expect(result).toContain('COMPLETED');
    expect(result).toContain('https://github.com/o/r/pull/1');
    expect(result).toContain('Bug Fix');
  });
});

describe('formatActivity', () => {
  it('formats agent messages', () => {
    const activity: Activity = {
      name: 'sessions/abc/activities/1',
      id: '1',
      description: 'Agent spoke',
      createTime: '2026-01-01T00:00:00Z',
      originator: 'agent',
      activity: { agentMessaged: { agentMessage: 'I found the bug' } },
    };
    const result = formatActivity(activity);
    expect(result).toContain('I found the bug');
    expect(result).toContain('Agent');
  });

  it('formats plan generated activities', () => {
    const activity: Activity = {
      name: 'sessions/abc/activities/2',
      id: '2',
      description: 'Plan created',
      createTime: '2026-01-01T00:00:00Z',
      originator: 'agent',
      activity: {
        planGenerated: {
          plan: {
            id: 'p1',
            steps: [{ id: 's1', index: 0, title: 'Step 1', description: 'Do thing' }],
            createTime: '2026-01-01T00:00:00Z',
          },
        },
      },
    };
    const result = formatActivity(activity);
    expect(result).toContain('Plan');
    expect(result).toContain('Step 1');
  });
});
