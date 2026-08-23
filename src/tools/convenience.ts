import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import { emitAudit } from '../audit.js';
import { formatSession } from '../formatters.js';
import {
    TERMINAL_STATES,
    normalizeResourceName,
    type Session,
} from '../types.js';
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

interface PollOptions {
    autoApprove: boolean;
    pollIntervalMs: number;
    deadline: number;
    normalizedSource: string;
    reason: string;
}

type PollOutcome =
    | { outcome: 'terminal'; session: Session }
    | { outcome: 'awaiting_plan_approval'; session: Session }
    | { outcome: 'awaiting_user_feedback'; session: Session }
    | { outcome: 'paused'; session: Session }
    | { outcome: 'timeout'; session: Session }
    | { outcome: 'error'; session: Session; error: string };

/** What pollToCompletion itself can return — the 'error' variant is only
 * synthesized by parallel mode's per-session catch. */
type LivePollOutcome = Exclude<PollOutcome, { outcome: 'error' }>;

/**
 * Poll one session until it reaches a terminal state, needs a human, or
 * the deadline passes. Auto-approves plans when opts.autoApprove is set.
 * Shared by single and parallel run_task modes (B1-119).
 */
async function pollToCompletion(
    client: JulesClient,
    session: Session,
    opts: PollOptions,
): Promise<LivePollOutcome> {
    let current = session;
    while (!TERMINAL_STATES.has(current.state) && Date.now() < opts.deadline) {
        if (current.state === 'AWAITING_PLAN_APPROVAL' && opts.autoApprove) {
            current = await client.approvePlan(current.id);
            await emitAudit({
                source: 'jules-mcp',
                category: 'coding-task',
                action: 'POST',
                service: opts.normalizedSource,
                reason: `Auto-approved plan for run_task: ${opts.reason}`,
                target: current.id,
            });
            await sleep(opts.pollIntervalMs);
            current = await client.getSession(current.id);
            continue;
        }

        if (current.state === 'AWAITING_PLAN_APPROVAL' && !opts.autoApprove) {
            return { outcome: 'awaiting_plan_approval', session: current };
        }

        if (current.state === 'AWAITING_USER_FEEDBACK') {
            return { outcome: 'awaiting_user_feedback', session: current };
        }

        // A paused session cannot progress on its own, so polling it is
        // pure waste — without this it burned the whole deadline (10 min by
        // default) and then reported `timeout`, which is not what happened.
        // PAUSED deliberately stays OUT of TERMINAL_STATES: that set means
        // "finished", and a paused session can be resumed (#50).
        if (current.state === 'PAUSED') {
            return { outcome: 'paused', session: current };
        }

        await sleep(opts.pollIntervalMs);
        current = await client.getSession(current.id);
    }

    return TERMINAL_STATES.has(current.state)
        ? { outcome: 'terminal', session: current }
        : { outcome: 'timeout', session: current };
}

/** One-line human note for a parallel-mode per-session outcome. */
function outcomeNote(o: PollOutcome): string {
    switch (o.outcome) {
        case 'terminal':
            return `Reached terminal state ${o.session.state}.`;
        case 'awaiting_plan_approval':
            return 'Plan ready for review — approve with jules_approve_plan.';
        case 'awaiting_user_feedback':
            return 'Needs user feedback — respond with jules_send_message.';
        case 'paused':
            return 'Session is paused — resume it in the Jules web app, or archive it with jules_archive_session.';
        case 'timeout':
            return `Timed out while still ${o.session.state} — poll with jules_get_session.`;
        case 'error':
            return `Polling failed: ${o.error} — poll with jules_get_session.`;
    }
}

export function registerConvenienceTools(
    server: McpServer,
    client: JulesClient,
): void {
    server.tool(
        'jules_run_task',
        'Create a Jules session, poll until plan is ready, auto-approve, and wait for completion. One-shot fire-and-forget for trusted tasks. With parallel > 1, creates N independent sessions with the same prompt and polls them all concurrently to completion, returning a per-session outcome summary.',
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
                                // Same semantics as single mode: Jules always
                                // requires approval; auto_approve controls
                                // whether WE approve during polling.
                                requirePlanApproval: true,
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

                    // Poll ALL sessions to completion concurrently (B1-119 —
                    // previously this returned immediately, contradicting the
                    // tool description). A failure polling one session does
                    // not abort the others.
                    const deadline = Date.now() + timeout_ms;
                    const outcomes = await Promise.all(
                        sessions.map((s) =>
                            pollToCompletion(client, s, {
                                autoApprove: auto_approve,
                                pollIntervalMs: poll_interval_ms,
                                deadline,
                                normalizedSource,
                                reason,
                            }).catch((error): PollOutcome => ({
                                outcome: 'error',
                                session: s,
                                error: String(error),
                            })),
                        ),
                    );

                    const completed = outcomes.filter(
                        (o) => o.outcome === 'terminal',
                    ).length;
                    const results = outcomes.map((o) => ({
                        id: o.session.id,
                        state: o.session.state,
                        url: o.session.url,
                        title: o.session.title,
                        outcome: o.outcome,
                        note: outcomeNote(o),
                    }));

                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify(
                                    {
                                        status:
                                            completed === parallel
                                                ? 'OK'
                                                : 'PARTIAL',
                                        message: `${completed}/${parallel} parallel sessions reached a terminal state.`,
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

                // 2. Poll until terminal or needs action (shared helper)
                const outcome = await pollToCompletion(client, session, {
                    autoApprove: auto_approve,
                    pollIntervalMs: poll_interval_ms,
                    deadline: Date.now() + timeout_ms,
                    normalizedSource,
                    reason,
                });

                if (outcome.outcome === 'awaiting_plan_approval') {
                    // User wants manual plan review — return so they can approve
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Session has a plan ready for review. Use jules_approve_plan to approve it.\n\n${formatSession(outcome.session)}`,
                            },
                        ],
                    };
                }

                if (outcome.outcome === 'awaiting_user_feedback') {
                    // Can't auto-handle user feedback — return current state
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Session needs user feedback. Use jules_send_message to respond.\n\n${formatSession(outcome.session)}`,
                            },
                        ],
                    };
                }

                if (outcome.outcome === 'paused') {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Session is paused and will not progress on its own. Resume it in the Jules web app, or archive it with jules_archive_session.\n\n${formatSession(outcome.session)}`,
                            },
                        ],
                    };
                }

                if (outcome.outcome === 'timeout') {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify({
                                    status: 'ERROR',
                                    message: `Timed out after ${timeout_ms}ms. Session is still ${outcome.session.state}.`,
                                    code: 408,
                                    session: formatSession(outcome.session),
                                }),
                            },
                        ],
                        isError: true,
                    };
                }

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: formatSession(outcome.session),
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
                    payload: { prompt, error: String(error), mode: 'run_task' },
                });
                return errorResponse(error);
            }
        },
    );
}
