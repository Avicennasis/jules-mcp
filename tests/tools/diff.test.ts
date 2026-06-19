import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDiffTools } from '../../src/tools/diff.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { Session, Activity } from '../../src/types.js';

const mockSession: Session = {
  name: 'sessions/abc',
  id: 'abc',
  prompt: 'fix it',
  title: 'Fix the thing',
  sourceContext: { source: 'sources/github/o/r' },
  state: 'COMPLETED',
  createTime: '2026-01-01T00:00:00Z',
  updateTime: '2026-01-01T00:00:00Z',
  url: 'https://jules.google/sessions/abc',
};

const mockActivities: Activity[] = [
  {
    name: 's/abc/activities/1', id: '1', createTime: 't', originator: 'agent',
    sessionCompleted: {},
    artifacts: [{
      changeSet: {
        source: 'sources/github/o/r',
        gitPatch: { unidiffPatch: 'diff --git a/f.js b/f.js\n+the change', baseCommitId: 'b', suggestedCommitMessage: 'commit msg' },
      },
    }],
  },
];

describe('diff tools', () => {
  let mockServer: any;
  let mockClient: Partial<JulesClient>;
  let registeredTools: Map<string, { handler: Function }>;

  beforeEach(() => {
    registeredTools = new Map();
    mockServer = {
      tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
        registeredTools.set(name, { handler });
      }),
    };
    mockClient = {
      getSession: vi.fn().mockResolvedValue(mockSession),
      listActivities: vi.fn().mockResolvedValue({ activities: mockActivities }),
    };

    registerDiffTools(mockServer, mockClient as JulesClient);
  });

  it('registers jules_get_session_diff', () => {
    expect(registeredTools.has('jules_get_session_diff')).toBe(true);
  });

  it('returns the consolidated diff', async () => {
    const handler = registeredTools.get('jules_get_session_diff')!.handler;
    const result = await handler({ session_id: 'abc' });
    expect(mockClient.getSession).toHaveBeenCalledWith('abc');
    expect(mockClient.listActivities).toHaveBeenCalledWith('abc', 200);
    expect(result.content[0].text).toContain('Fix the thing');
    expect(result.content[0].text).toContain('+the change');
    expect(result.content[0].text).toContain('commit msg');
  });

  it('returns a structured error when the session is not found', async () => {
    const { JulesNotFoundError } = await import('../../src/errors.js');
    (mockClient.getSession as any).mockRejectedValueOnce(new JulesNotFoundError('sessions/nope'));
    const handler = registeredTools.get('jules_get_session_diff')!.handler;
    const result = await handler({ session_id: 'nope' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('ERROR');
    expect(parsed.code).toBe(404);
    expect(result.isError).toBe(true);
  });
});
