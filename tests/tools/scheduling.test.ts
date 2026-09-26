import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerSchedulingTools } from '../../src/tools/scheduling.js';
import { emitAudit } from '../../src/audit.js';
import type { ScheduleManager } from '../../src/scheduler/cron.js';

vi.mock('../../src/audit.js', () => ({
    emitAudit: vi.fn().mockResolvedValue(undefined),
}));

const emitAuditMock = vi.mocked(emitAudit);

describe('scheduling tools', () => {
    let mockServer: any;
    let mockManager: Partial<ScheduleManager>;
    let registeredTools: Map<string, { handler: Function }>;

    beforeEach(() => {
        vi.resetAllMocks();
        emitAuditMock.mockResolvedValue(undefined);
        registeredTools = new Map();
        mockServer = {
            tool: vi.fn(
                (
                    name: string,
                    _desc: string,
                    _schema: any,
                    handler: Function,
                ) => {
                    registeredTools.set(name, { handler });
                },
            ),
        };
        mockManager = {
            add: vi.fn().mockReturnValue({
                id: 'sched-1',
                label: 'Weekly lint',
                cron: '0 9 * * 1',
                prompt: 'lint',
                source: 's',
                startingBranch: 'main',
                requirePlanApproval: true,
                createdAt: '2026-01-01T00:00:00Z',
            }),
            list: vi.fn().mockReturnValue([]),
            remove: vi.fn().mockReturnValue(true),
        };

        registerSchedulingTools(mockServer, mockManager as ScheduleManager);
    });

    it('registers schedule, list and delete tools', () => {
        expect(registeredTools.has('jules_schedule_task')).toBe(true);
        expect(registeredTools.has('jules_list_schedules')).toBe(true);
        // #50434: delete is its own tool, no longer an action on the list tool.
        expect(registeredTools.has('jules_delete_schedule')).toBe(true);
    });

    it('jules_schedule_task with dry_run returns DRY_RUN', async () => {
        const handler = registeredTools.get('jules_schedule_task')!.handler;
        const result = await handler({
            cron: '0 9 * * 1',
            prompt: 'lint',
            source: 's',
            starting_branch: 'main',
            label: 'Weekly lint',
            reason: 'automation',
            dry_run: true,
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe('DRY_RUN');
        expect(mockManager.add).not.toHaveBeenCalled();
    });

    it('jules_schedule_task creates a schedule', async () => {
        const handler = registeredTools.get('jules_schedule_task')!.handler;
        await handler({
            cron: '0 9 * * 1',
            prompt: 'lint',
            source: 's',
            starting_branch: 'main',
            label: 'Weekly lint',
            reason: 'automation',
        });
        expect(mockManager.add).toHaveBeenCalled();
    });

    it('jules_list_schedules lists, and takes no action params', async () => {
        mockManager.list = vi
            .fn()
            .mockReturnValue([{ id: 'sched-1', label: 'Weekly lint' }]);
        const handler = registeredTools.get('jules_list_schedules')!.handler;
        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe('OK');
        expect(parsed.count).toBe(1);
        expect(parsed.schedules).toHaveLength(1);
        expect(mockManager.remove).not.toHaveBeenCalled();
    });

    it('jules_delete_schedule refuses without confirm_destructive', async () => {
        const handler = registeredTools.get('jules_delete_schedule')!.handler;
        const result = await handler({
            schedule_id: 'sched-1',
            reason: 'no longer needed',
            confirm_destructive: false,
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe('CONFIRMATION_REQUIRED');
        expect(result.isError).toBe(true);
        expect(mockManager.remove).not.toHaveBeenCalled();
        expect(emitAuditMock).not.toHaveBeenCalled();
    });

    it('jules_delete_schedule deletes and emits an audit record', async () => {
        mockManager.list = vi
            .fn()
            .mockReturnValue([
                { id: 'sched-1', source: 'sources/github/owner/repo' },
            ]);
        const handler = registeredTools.get('jules_delete_schedule')!.handler;
        const result = await handler({
            schedule_id: 'sched-1',
            reason: 'no longer needed',
            confirm_destructive: true,
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe('OK');
        expect(mockManager.remove).toHaveBeenCalledWith('sched-1');
        expect(emitAuditMock).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'DELETE',
                target: 'sched-1',
                service: 'sources/github/owner/repo',
                reason: 'no longer needed',
            }),
        );
    });

    it('jules_delete_schedule returns a structured 404 for a missing schedule', async () => {
        mockManager.remove = vi.fn().mockReturnValue(false);
        const handler = registeredTools.get('jules_delete_schedule')!.handler;
        const result = await handler({
            schedule_id: 'ghost',
            reason: 'cleanup',
            confirm_destructive: true,
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe('ERROR');
        expect(parsed.code).toBe(404);
        expect(result.isError).toBe(true);
        expect(emitAuditMock).not.toHaveBeenCalled();
    });

    // #50433 -- the handler must refuse a sub-hourly cron and report the
    // computed interval, not merely validate that the expression parses.
    describe('cron interval gate (#50433)', () => {
        const ORIG = process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
        afterEach(() => {
            if (ORIG === undefined)
                delete process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
            else process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS = ORIG;
        });

        it('refuses a 6-field per-second schedule via the dry_run path', async () => {
            delete process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
            const handler = registeredTools.get('jules_schedule_task')!.handler;
            const result = await handler({
                cron: '*/1 * * * * *',
                prompt: 'lint',
                source: 'sources/github/o/r',
                starting_branch: 'main',
                label: 'Per second',
                reason: 'automation',
                dry_run: true,
            });
            const parsed = JSON.parse(result.content[0].text);
            expect(parsed.status).toBe('ERROR');
            expect(parsed.code).toBe(400);
            expect(parsed.computed_interval_seconds).toBe(1);
            expect(parsed.minimum_interval_seconds).toBe(3600);
            expect(result.isError).toBe(true);
            expect(mockManager.add).not.toHaveBeenCalled();
        });

        it('refuses a minutely schedule on the create path', async () => {
            delete process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
            const handler = registeredTools.get('jules_schedule_task')!.handler;
            const result = await handler({
                cron: '* * * * *',
                prompt: 'lint',
                source: 'sources/github/o/r',
                starting_branch: 'main',
                label: 'Every minute',
                reason: 'automation',
            });
            const parsed = JSON.parse(result.content[0].text);
            expect(parsed.status).toBe('ERROR');
            expect(parsed.computed_interval_seconds).toBe(60);
            expect(mockManager.add).not.toHaveBeenCalled();
        });

        it('dry_run reports the computed interval for an accepted schedule', async () => {
            delete process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
            const handler = registeredTools.get('jules_schedule_task')!.handler;
            const result = await handler({
                cron: '0 * * * *',
                prompt: 'lint',
                source: 'sources/github/o/r',
                starting_branch: 'main',
                label: 'Hourly',
                reason: 'automation',
                dry_run: true,
            });
            const parsed = JSON.parse(result.content[0].text);
            expect(parsed.status).toBe('DRY_RUN');
            expect(parsed.computed_interval_seconds).toBe(3600);
            expect(parsed.minimum_interval_seconds).toBe(3600);
        });
    });
});
