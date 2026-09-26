import { z } from 'zod';
import cron from 'node-cron';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScheduleManager } from '../scheduler/cron.js';
import { emitAudit } from '../audit.js';
import { JulesAPIError } from '../errors.js';
import { checkSourceAllowed } from '../allowlist.js';
import { normalizeResourceName } from '../types.js';

function errorResponse(error: unknown) {
    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify(
                    error instanceof JulesAPIError
                        ? error.toJSON()
                        : {
                              status: 'ERROR',
                              message: String(error),
                              code: 500,
                          },
                ),
            },
        ],
        isError: true,
    };
}

export function registerSchedulingTools(
    server: McpServer,
    manager: ScheduleManager,
): void {
    server.tool(
        'jules_schedule_task',
        'Schedule a recurring Jules coding task using a cron expression',
        {
            cron: z
                .string()
                .describe(
                    'Cron expression (e.g. "0 9 * * 1" for every Monday 9am)',
                ),
            prompt: z.string().describe('What Jules should do each time'),
            source: z
                .string()
                .describe('Source name (e.g. "sources/github/owner/repo")'),
            starting_branch: z.string().describe('Branch to start from'),
            label: z.string().describe('Human-readable name for this schedule'),
            require_plan_approval: z
                .boolean()
                .default(true)
                .describe('Require plan approval'),
            automation_mode: z
                .enum(['AUTOMATION_MODE_UNSPECIFIED', 'AUTO_CREATE_PR'])
                .optional(),
            reason: z
                .string()
                .describe('Why this schedule is being created (for audit log)'),
            dry_run: z
                .boolean()
                .default(false)
                .describe('Preview without creating'),
        },
        async ({
            cron: cronExpr,
            prompt,
            source,
            starting_branch,
            label,
            require_plan_approval,
            automation_mode,
            reason,
            dry_run,
        }) => {
            // #50432: bound WHICH REPO this may touch, before the schedule is
            // stored. A schedule is worse than a one-shot here -- it re-fires,
            // so an unbounded one keeps targeting the wrong repo daily. Checked
            // before the cron validation so a denied repo is refused even when
            // the expression is also bad; dry_run is a preview, not an
            // exemption.
            const allowlist = process.env.JULES_ALLOWED_REPOS;
            const gate = checkSourceAllowed(
                normalizeResourceName(source, 'sources'),
                allowlist,
            );
            if (!gate.allowed) {
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'DENY',
                    service: normalizeResourceName(source, 'sources'),
                    reason,
                    payload: { denied_by: 'allowlist', repo: gate.repo, label },
                });
                return errorResponse(new JulesAPIError(gate.message, 403));
            }

            const input = {
                label,
                cron: cronExpr,
                prompt,
                source,
                startingBranch: starting_branch,
                requirePlanApproval: require_plan_approval,
                automationMode: automation_mode,
            };

            // Validate cron BEFORE the dry_run return so previews surface bad expressions too
            if (!cron.validate(input.cron)) {
                return errorResponse(
                    new Error(`Invalid cron expression: ${input.cron}`),
                );
            }

            if (dry_run) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    status: 'DRY_RUN',
                                    dry_run: true,
                                    would_create: input,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            }

            try {
                const entry = manager.add(input);
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'scheduling',
                    action: 'POST',
                    service: source,
                    reason,
                    target: entry.id,
                    payload: { label, cron: cronExpr, prompt },
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                { status: 'OK', schedule: entry },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return errorResponse(error);
            }
        },
    );

    server.tool(
        'jules_list_schedules',
        'List scheduled Jules tasks. Read-only — deleting a schedule is the separate, destructive jules_delete_schedule tool.',
        {},
        async () => {
            const schedules = manager.list();
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                status: 'OK',
                                count: schedules.length,
                                schedules,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    // #50434. Deleting used to be `jules_list_schedules(action: 'delete')`: an
    // action enum on a LIST tool, so a destructive operation shared a name with
    // a read and a model scanning tool names could not see it. It is its own
    // tool now, marked destructive and gated like jules_delete_session.
    server.tool(
        'jules_delete_schedule',
        'Permanently delete a scheduled Jules task. IRREVERSIBLE — re-create it with jules_schedule_task if needed. Requires confirm_destructive=true.',
        {
            schedule_id: z.string().describe('Schedule ID to delete'),
            reason: z
                .string()
                .describe('Why this schedule is being deleted (for audit log)'),
            confirm_destructive: z
                .boolean()
                .default(false)
                .describe('Must be true to actually delete (safety guard)'),
        },
        async ({ schedule_id, reason, confirm_destructive }) => {
            if (!confirm_destructive) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                status: 'CONFIRMATION_REQUIRED',
                                message:
                                    'Deleting a schedule is irreversible. Re-call with confirm_destructive=true.',
                            }),
                        },
                    ],
                    isError: true,
                };
            }
            // Look up the entry source BEFORE removing so the audit captures it
            const entry = manager.list().find((e) => e.id === schedule_id);
            const removed = manager.remove(schedule_id);
            if (!removed) {
                // Structured not-found, so a caller can tell "already gone" from
                // "the delete failed".
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    status: 'ERROR',
                                    code: 404,
                                    message: `Schedule ${schedule_id} not found`,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                    isError: true,
                };
            }
            await emitAudit({
                source: 'jules-mcp',
                category: 'scheduling',
                action: 'DELETE',
                service: entry?.source ?? schedule_id,
                reason,
                target: schedule_id,
            });
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                status: 'OK',
                                message: `Schedule ${schedule_id} deleted`,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );
}
