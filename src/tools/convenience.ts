import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import { emitAudit } from '../audit.js';
import { formatSession } from '../formatters.js';
import { TERMINAL_STATES, normalizeResourceName } from '../types.js';
import { JulesAPIError } from '../errors.js';

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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerConvenienceTools(
    server: McpServer,
    client: JulesClient,
): void {
    server.tool(
        'jules_run_task',
        'Create a Jules session, poll until plan is ready, auto-approve, and wait for completion. One-shot fire-and-forget for trusted tasks.',
        {
            prompt: z.string().describe('What Jules should do'),
            source: z.string().describe('Source name'),
            starting_branch: z.string().describe('Branch to start from'),
            title: z.string().optional().describe('Optional session title'),
            automation_mode: z
                .enum(['AUTOMATION_MODE_UNSPECIFIED', 'AUTO_CREATE_PR'])
                .optional(),
            reason: z
                .string()
                .describe('Why this task is being run (for audit log)'),
            auto_approve: z
                .boolean()
                .default(true)
                .describe('Auto-approve the plan when ready'),
            poll_interval_ms: z
                .number()
                .int()
                .positive()
                .default(5000)
                .describe('Polling interval in milliseconds'),
            timeout_ms: z
                .number()
                .int()
                .positive()
                .default(600000)
                .describe(
                    'Maximum wait time in milliseconds (default 10 minutes)',
                ),
            parallel: z
                .number()
                .int()
                .min(1)
                .max(10)
                .default(1)
                .describe(
                    "Number of parallel sessions to create with the same prompt (1-10, default 1). Each runs independently. Inspired by the Jules CLI's --parallel flag.",
                ),
        },
        async ({
            prompt,
            source,
            starting_branch,
            title,
            automation_mode,
            reason,
            auto_approve,
            poll_interval_ms,
            timeout_ms,
            parallel,
        }) => {
            const normalizedSource = normalizeResourceName(source, 'sources');

            // --- Parallel mode: fan out N sessions, poll all concurrently ---
            if (parallel > 1) {
                try {
                    const sessions = await Promise.all(
                        Array.from({ length: parallel }, (_, i) =>
                            client.createSession({
                                prompt,
                                sourceContext: {
                                    source: normalizedSource,
                                    githubRepoContext: {
                                        startingBranch: starting_branch,
                                    },
                                },
                                title: title
                                    ? `${title} (${i + 1}/${parallel})`
                                    : undefined,
                                requirePlanApproval: !auto_approve,
                                automationMode: automation_mode,
                            }),
                        ),
                    );

                    for (const s of sessions) {
                        await emitAudit({
                            source: 'jules-mcp',
                            category: 'coding-task',
                            action: 'POST',
                            service: normalizedSource,
                            reason,
                            target: s.id,
                            payload: {
                                prompt,
                                title,
                                mode: 'run_task_parallel',
                                parallel,
                            },
                        });
                    }

                    const results = sessions.map((s) => ({
                        id: s.id,
                        state: s.state,
                        url: s.url,
                        title: s.title,
                    }));

                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify(
                                    {
                                        status: 'OK',
                                        message: `Created ${parallel} parallel sessions. Poll each with jules_get_session or jules_get_session_diff.`,
                                        sessions: results,
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                } catch (error) {
                    await emitAudit({
                        source: 'jules-mcp',
                        category: 'coding-task',
                        action: 'POST_FAIL',
                        service: normalizedSource,
                        reason,
                        payload: {
                            prompt,
                            error: String(error),
                            mode: 'run_task_parallel',
                        },
                    });
                    return errorResponse(error);
                }
            }

            // --- Single session mode (existing behavior) ---
            try {
                // 1. Create session
                const session = await client.createSession({
                    prompt,
                    sourceContext: {
                        source: normalizedSource,
                        githubRepoContext: { startingBranch: starting_branch },
                    },
                    title,
                    requirePlanApproval: true, // always require — auto_approve controls whether WE approve, not whether Jules skips
                    automationMode: automation_mode,
                });

                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST',
                    service: normalizedSource,
                    reason,
                    target: session.id,
                    payload: { prompt, title, mode: 'run_task' },
                });

                const deadline = Date.now() + timeout_ms;

                // 2. Poll until terminal or needs action
                let current = session;
                while (
                    !TERMINAL_STATES.has(current.state) &&
                    Date.now() < deadline
                ) {
                    if (
                        current.state === 'AWAITING_PLAN_APPROVAL' &&
                        auto_approve
                    ) {
                        current = await client.approvePlan(current.id);
                        await emitAudit({
                            source: 'jules-mcp',
                            category: 'coding-task',
                            action: 'POST',
                            service: normalizedSource,
                            reason: `Auto-approved plan for run_task: ${reason}`,
                            target: current.id,
                        });
                        await sleep(poll_interval_ms);
                        current = await client.getSession(current.id);
                        continue;
                    }

                    if (
                        current.state === 'AWAITING_PLAN_APPROVAL' &&
                        !auto_approve
                    ) {
                        // User wants manual plan review — return so they can approve
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `Session has a plan ready for review. Use jules_approve_plan to approve it.\n\n${formatSession(current)}`,
                                },
                            ],
                        };
                    }

                    if (current.state === 'AWAITING_USER_FEEDBACK') {
                        // Can't auto-handle user feedback — return current state
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `Session needs user feedback. Use jules_send_message to respond.\n\n${formatSession(current)}`,
                                },
                            ],
                        };
                    }

                    await sleep(poll_interval_ms);
                    current = await client.getSession(current.id);
                }

                if (!TERMINAL_STATES.has(current.state)) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify({
                                    status: 'ERROR',
                                    message: `Timed out after ${timeout_ms}ms. Session is still ${current.state}.`,
                                    code: 408,
                                    session: formatSession(current),
                                }),
                            },
                        ],
                        isError: true,
                    };
                }

                return {
                    content: [
                        { type: 'text' as const, text: formatSession(current) },
                    ],
                };
            } catch (error) {
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST_FAIL',
                    service: normalizedSource,
                    reason,
                    payload: { prompt, error: String(error), mode: 'run_task' },
                });
                return errorResponse(error);
            }
        },
    );
}
