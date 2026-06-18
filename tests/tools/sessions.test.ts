import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerSessionTools } from '../../src/tools/sessions.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { Session } from '../../src/types.js';

vi.mock('../../src/audit.js', () => ({
  emitAudit: vi.fn().mockResolvedValue(undefined),
}));

const mockSession: Session = {
  name: 'sessions/abc',
  id: 'abc',
  prompt: 'fix bug',
  sourceContext: { source: 'sources/github/o/r' },
  state: 'QUEUED',
  createTime: '2026-01-01T00:00:00Z',
  updateTime: '2026-01-01T00:00:00Z',
  url: 'https://jules.google/sessions/abc',
};

describe('session tools', () => {
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
    mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      listSessions: vi.fn().mockResolvedValue({ sessions: [mockSession] }),
      getSession: vi.fn().mockResolvedValue(mockSession),
      approvePlan: vi.fn().mockResolvedValue({ ...mockSession, state: 'IN_PROGRESS' }),
      sendMessage: vi.fn().mockResolvedValue({ ...mockSession, state: 'IN_PROGRESS' }),
    };

    registerSessionTools(mockServer, mockClient as JulesClient);
  });

  it('registers all 5 session tools', () => {
    expect(registeredTools.has('jules_create_session')).toBe(true);
    expect(registeredTools.has('jules_list_sessions')).toBe(true);
    expect(registeredTools.has('jules_get_session')).toBe(true);
    expect(registeredTools.has('jules_approve_plan')).toBe(true);
    expect(registeredTools.has('jules_send_message')).toBe(true);
  });

  it('jules_create_session with dry_run returns DRY_RUN status', async () => {
    const handler = registeredTools.get('jules_create_session')!.handler;
    const result = await handler({
      prompt: 'fix bug',
      source: 'sources/github/o/r',
      starting_branch: 'main',
      reason: 'testing',
      dry_run: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('DRY_RUN');
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('jules_create_session calls client and emits audit', async () => {
    const { emitAudit } = await import('../../src/audit.js');
    const handler = registeredTools.get('jules_create_session')!.handler;
    await handler({
      prompt: 'fix bug',
      source: 'sources/github/o/r',
      starting_branch: 'main',
      reason: 'need to fix it',
    });
    expect(mockClient.createSession).toHaveBeenCalled();
    expect(emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'jules-mcp',
      category: 'coding-task',
      action: 'POST',
      reason: 'need to fix it',
    }));
  });

  it('jules_approve_plan rejects when session is not AWAITING_PLAN_APPROVAL', async () => {
    // getSession returns IN_PROGRESS state, so approve should fail with state error
    const handler = registeredTools.get('jules_approve_plan')!.handler;
    const result = await handler({ session_id: 'abc', reason: 'approving' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('ERROR');
    expect(parsed.code).toBe(409);
    expect(result.isError).toBe(true);
    expect(mockClient.approvePlan).not.toHaveBeenCalled();
  });

  it('jules_get_session returns formatted session', async () => {
    const handler = registeredTools.get('jules_get_session')!.handler;
    const result = await handler({ session_id: 'abc' });
    expect(result.content[0].text).toContain('abc');
  });
});
