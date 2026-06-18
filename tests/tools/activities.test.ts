import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerActivityTools } from '../../src/tools/activities.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { Activity } from '../../src/types.js';

const mockActivity: Activity = {
  name: 'sessions/abc/activities/1',
  id: '1',
  description: 'Agent sent message',
  createTime: '2026-01-01T00:00:00Z',
  originator: 'agent',
  activity: { agentMessaged: { agentMessage: 'Found the bug' } },
};

describe('activity tools', () => {
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
      listActivities: vi.fn().mockResolvedValue({ activities: [mockActivity] }),
      getActivity: vi.fn().mockResolvedValue(mockActivity),
    };

    registerActivityTools(mockServer, mockClient as JulesClient);
  });

  it('registers jules_list_activities and jules_get_activity', () => {
    expect(registeredTools.has('jules_list_activities')).toBe(true);
    expect(registeredTools.has('jules_get_activity')).toBe(true);
  });

  it('jules_list_activities returns formatted activities', async () => {
    const handler = registeredTools.get('jules_list_activities')!.handler;
    const result = await handler({ session_id: 'abc' });
    expect(result.content[0].text).toContain('Found the bug');
  });

  it('jules_get_activity returns single activity', async () => {
    const handler = registeredTools.get('jules_get_activity')!.handler;
    const result = await handler({ session_id: 'abc', activity_id: '1' });
    expect(result.content[0].text).toContain('Found the bug');
    expect(mockClient.getActivity).toHaveBeenCalledWith('abc', '1');
  });
});
