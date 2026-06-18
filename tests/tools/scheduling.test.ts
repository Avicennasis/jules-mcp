import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerSchedulingTools } from '../../src/tools/scheduling.js';
import type { ScheduleManager } from '../../src/scheduler/cron.js';

vi.mock('../../src/audit.js', () => ({
  emitAudit: vi.fn().mockResolvedValue(undefined),
}));

describe('scheduling tools', () => {
  let mockServer: any;
  let mockManager: Partial<ScheduleManager>;
  let registeredTools: Map<string, { handler: Function }>;

  beforeEach(() => {
    vi.resetAllMocks();
    registeredTools = new Map();
    mockServer = {
      tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
        registeredTools.set(name, { handler });
      }),
    };
    mockManager = {
      add: vi.fn().mockReturnValue({
        id: 'sched-1', label: 'Weekly lint', cron: '0 9 * * 1',
        prompt: 'lint', source: 's', startingBranch: 'main',
        requirePlanApproval: true, createdAt: '2026-01-01T00:00:00Z',
      }),
      list: vi.fn().mockReturnValue([]),
      remove: vi.fn().mockReturnValue(true),
    };

    registerSchedulingTools(mockServer, mockManager as ScheduleManager);
  });

  it('registers jules_schedule_task and jules_list_schedules', () => {
    expect(registeredTools.has('jules_schedule_task')).toBe(true);
    expect(registeredTools.has('jules_list_schedules')).toBe(true);
  });

  it('jules_schedule_task with dry_run returns DRY_RUN', async () => {
    const handler = registeredTools.get('jules_schedule_task')!.handler;
    const result = await handler({
      cron: '0 9 * * 1', prompt: 'lint', source: 's',
      starting_branch: 'main', label: 'Weekly lint',
      reason: 'automation', dry_run: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('DRY_RUN');
    expect(mockManager.add).not.toHaveBeenCalled();
  });

  it('jules_schedule_task creates a schedule', async () => {
    const handler = registeredTools.get('jules_schedule_task')!.handler;
    await handler({
      cron: '0 9 * * 1', prompt: 'lint', source: 's',
      starting_branch: 'main', label: 'Weekly lint',
      reason: 'automation',
    });
    expect(mockManager.add).toHaveBeenCalled();
  });

  it('jules_list_schedules with delete action removes', async () => {
    const handler = registeredTools.get('jules_list_schedules')!.handler;
    await handler({ action: 'delete', schedule_id: 'sched-1', reason: 'no longer needed' });
    expect(mockManager.remove).toHaveBeenCalledWith('sched-1');
  });
});
