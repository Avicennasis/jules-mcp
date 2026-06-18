import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerConvenienceTools } from '../../src/tools/convenience.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { Session } from '../../src/types.js';

vi.mock('../../src/audit.js', () => ({
  emitAudit: vi.fn().mockResolvedValue(undefined),
}));

describe('convenience tools', () => {
  let mockServer: any;
  let mockClient: Partial<JulesClient>;
  let registeredTools: Map<string, { handler: Function }>;

  beforeEach(() => {
    vi.resetAllMocks();
    registeredTools = new Map();
    mockServer = {
      tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
        registeredTools.set(name, { handler });
      }),
    };

    const sessionSequence: Session[] = [
      { name: 's/1', id: '1', prompt: 'p', sourceContext: { source: 's' }, state: 'QUEUED', createTime: '', updateTime: '', url: '' },
      { name: 's/1', id: '1', prompt: 'p', sourceContext: { source: 's' }, state: 'AWAITING_PLAN_APPROVAL', createTime: '', updateTime: '', url: '' },
      { name: 's/1', id: '1', prompt: 'p', sourceContext: { source: 's' }, state: 'IN_PROGRESS', createTime: '', updateTime: '', url: '' },
      { name: 's/1', id: '1', prompt: 'p', sourceContext: { source: 's' }, state: 'COMPLETED', createTime: '', updateTime: '', url: '', outputs: [{ pullRequest: { url: 'https://pr', title: 'PR', description: 'd' } }] },
    ];
    let callCount = 0;

    mockClient = {
      createSession: vi.fn().mockResolvedValue(sessionSequence[0]),
      getSession: vi.fn().mockImplementation(async () => {
        callCount++;
        return sessionSequence[Math.min(callCount, sessionSequence.length - 1)];
      }),
      approvePlan: vi.fn().mockResolvedValue(sessionSequence[2]),
    };

    registerConvenienceTools(mockServer, mockClient as JulesClient);
  });

  it('registers jules_run_task', () => {
    expect(registeredTools.has('jules_run_task')).toBe(true);
  });

  it('runs through create → poll → approve → poll → complete', async () => {
    const handler = registeredTools.get('jules_run_task')!.handler;
    const result = await handler({
      prompt: 'fix bug',
      source: 'sources/github/o/r',
      starting_branch: 'main',
      reason: 'need fix',
      auto_approve: true,
      poll_interval_ms: 10, // fast for tests
      timeout_ms: 5000,
    });
    expect(mockClient.createSession).toHaveBeenCalled();
    expect(mockClient.approvePlan).toHaveBeenCalled();
    expect(result.content[0].text).toContain('COMPLETED');
  });
});
