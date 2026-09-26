import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import { emitAudit } from '../audit.js';
import { buildDispatchEntry, recordDispatch } from '../dispatch-log.js';
import { formatSession } from '../formatters.js';
import {
    TERMINAL_STATES,
    normalizeResourceName,
    type Session,
    isActiveState,
} from '../types.js';
import { JulesAPIError } from '../errors.js';
import { checkSourceAllowed } from '../allowlist.js';

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
    | { outcome: 'unknown_state'; session: Session }
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
    // Structured as "poll only while the state is one we RECOGNISE as still
    // working", not "poll until terminal". The old form continued on anything
    // outside TERMINAL_STATES, so a session in CANCELED or COMPLETED_UNKNOWN --
    // finished, under a name we had not listed -- polled to the 600s deadline
    // and was then reported as a `timeout`. Four surveyed repos gave four
    // disagreeing state vocabularies, several of them guesses, so the
    // enumeration cannot be completed by collecting names; the default branch
    // has to be the safe one instead (#50647, #50777).
    let current = session;
    for (;;) {
        const state = current.state;

        if (TERMINAL_STATES.has(state)) {
            return { outcome: 'terminal', session: current };
        }

        // The one state we act on rather than report, so it is handled first --
        // it is the only branch that falls through to another iteration.
        if (state === 'AWAITING_PLAN_APPROVAL') {
            if (!opts.autoApprove) {
                return { outcome: 'awaiting_plan_approval', session: current };
            }
            if (Date.now() >= opts.deadline) {
                return { outcome: 'timeout', session: current };
            }
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

        // AWAITING_USER_INPUT is the legacy name for AWAITING_USER_FEEDBACK.
        if (
            state === 'AWAITING_USER_FEEDBACK' ||
            state === 'AWAITING_USER_INPUT'
        ) {
            return { outcome: 'awaiting_user_feedback', session: current };
        }

        // A paused session cannot progress on its own, so polling it is
        // pure waste -- without this it burned the whole deadline (10 min by
        // default) and then reported `timeout`, which is not what happened.
        // PAUSED deliberately stays OUT of TERMINAL_STATES: that set means
        // "finished", and a paused session can be resumed (#50).
        if (state === 'PAUSED') {
            return { outcome: 'paused', session: current };
        }

        // Not terminal, not actionable, and not a state we know keeps moving.
        // Stop and say so rather than polling something that may never change.
        if (!isActiveState(state)) {
            return { outcome: 'unknown_state', session: current };
        }

        if (Date.now() >= opts.deadline) {
            return { outcome: 'timeout', session: current };
        }

        await sleep(opts.pollIntervalMs);
        current = await client.getSession(current.id);
    }
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
        case 'unknown_state':
            return `Stopped at state ${o.session.state}, which this server does not recognise — check the session in the Jules web app. Reported verbatim rather than polled, so this is not a timeout.`;
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

            // #50432: bound WHICH REPO this may touch, before anything is
            // created. dry_run is a preview, not an exemption -- a denied repo
            // is refused in both modes so the preview cannot become the
            // rehearsal for a request that would be refused anyway.
            const allowlist = process.env.JULES_ALLOWED_REPOS;
            const gate = checkSourceAllowed(normalizedSource, allowlist);
            if (!gate.allowed) {
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'DENY',
                    service: normalizedSource,
                    reason,
                    payload: { denied_by: 'allowlist', repo: gate.repo },
                });
                return errorResponse(new JulesAPIError(gate.message, 403));
            }

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

                    // #50646: record the batch locally BEFORE polling, so its
                    // ids survive context loss (compaction, a client close)
                    // even if polling is interrupted. A write failure is a
                    // warning, never a failure -- the sessions are already
                    // running on Jules, which is the work that matters.
                    const dispatchWrite = recordDispatch(
                        buildDispatchEntry({
                            mode: 'run_task_parallel',
                            source: normalizedSource,
                            branch: starting_branch,
                            reason,
                            prompt,
                            parallel,
                            sessions,
                        }),
                    );

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
                                        // #50646: never let the reader assume
                                        // the ids are recoverable when the
                                        // write failed.
                                        dispatch_log: dispatchWrite.ok
                                            ? {
                                                  ok: true,
                                                  path: dispatchWrite.path,
                                              }
                                            : {
                                                  ok: false,
                                                  path: dispatchWrite.path,
                                                  warning: `dispatch log write FAILED (${dispatchWrite.error}); these session ids are NOT persisted locally — copy them now, and use jules_list_dispatches to confirm.`,
                                              },
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

                // #50646: record locally before polling, so the id survives
                // context loss. A write failure is a warning, never a failure.
                const dispatchWrite = recordDispatch(
                    buildDispatchEntry({
                        mode: 'run_task',
                        source: normalizedSource,
                        branch: starting_branch,
                        reason,
                        prompt,
                        parallel: 1,
                        sessions: [session],
                    }),
                );
                const dispatchWarning = dispatchWrite.ok
                    ? ''
                    : `\n\n⚠ dispatch log write FAILED (${dispatchWrite.error}); this session id is NOT persisted locally — copy it now: ${session.id} (log path ${dispatchWrite.path}).`;

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
                                text: `Session has a plan ready for review. Use jules_approve_plan to approve it.\n\n${formatSession(outcome.session) + dispatchWarning}`,
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
                                text: `Session needs user feedback. Use jules_send_message to respond.\n\n${formatSession(outcome.session) + dispatchWarning}`,
                            },
                        ],
                    };
                }

                if (outcome.outcome === 'paused') {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Session is paused and will not progress on its own. Resume it in the Jules web app, or archive it with jules_archive_session.\n\n${formatSession(outcome.session) + dispatchWarning}`,
                            },
                        ],
                    };
                }

                if (outcome.outcome === 'unknown_state') {
                    // Deliberately NOT isError: nothing failed. The session
                    // reached a state this server does not have a rule for,
                    // which is expected against a v1alpha API we chase.
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Session reached state ${outcome.session.state}, which this server does not recognise, so polling stopped rather than running to the timeout. Check it in the Jules web app.\n\n${formatSession(outcome.session) + dispatchWarning}`,
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
                                    session: formatSession(outcome.session) + dispatchWarning,
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
                            text: formatSession(outcome.session) + dispatchWarning,
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

    // ── jules_run_tasks: one session per entry in a task LIST ───────────────
    //
    // Redmine #50655. `jules_run_task`'s `parallel` is a fan-out of ONE prompt
    // (N attempts at the same problem). This is the other shape: N DIFFERENT
    // prompts, one session each. The README claimed that was already shipped via
    // `parallel`; it was not, and the two documents contradicted each other.
    //
    // The cap is a politeness bound, not a quota one: #50428 found no measured
    // daily ceiling on the Jules API (and it has no idempotency key), so there
    // is nothing better to derive it from than the 10 `parallel` already uses.
    const TASK_LIST_CONCURRENCY_CAP = 10;

    server.tool(
        'jules_run_tasks',
        "Create ONE Jules session per entry in a task list — N DIFFERENT prompts, unlike jules_run_task's parallel mode which fans out a SINGLE prompt N times. Polls every created session concurrently to completion and reports a per-entry outcome. With dry_run, renders every would-be request and creates nothing.",
        {
            tasks: z
                .array(
                    z.object({
                        prompt: z
                            .string()
                            .describe('What Jules should do for THIS entry'),
                        title: z.string().optional(),
                        source: z
                            .string()
                            .optional()
                            .describe('Overrides the shared source'),
                        starting_branch: z
                            .string()
                            .optional()
                            .describe('Overrides the shared starting_branch'),
                        automation_mode: z
                            .enum([
                                'AUTOMATION_MODE_UNSPECIFIED',
                                'AUTO_CREATE_PR',
                            ])
                            .optional(),
                    }),
                )
                .min(1)
                .describe(
                    'One session per entry. Entries are independent prompts, not repeats.',
                ),
            source: z
                .string()
                .describe('Default source for entries that do not override it'),
            starting_branch: z
                .string()
                .describe('Default branch for entries that do not override it'),
            automation_mode: z
                .enum(['AUTOMATION_MODE_UNSPECIFIED', 'AUTO_CREATE_PR'])
                .optional(),
            reason: z
                .string()
                .describe('Why these tasks are being run (for audit log)'),
            auto_approve: z
                .boolean()
                .default(true)
                .describe('Auto-approve each plan when it is ready'),
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
                    'Maximum wait time in milliseconds (default 10 minutes), applied to all sessions',
                ),
            concurrency: z
                .number()
                .int()
                .min(1)
                .max(TASK_LIST_CONCURRENCY_CAP)
                .default(TASK_LIST_CONCURRENCY_CAP)
                .describe(
                    `Maximum sessions in flight at once (1-${TASK_LIST_CONCURRENCY_CAP}). A politeness bound, not a quota one — the Jules API exposes no measured daily ceiling (#50428).`,
                ),
            dry_run: z
                .boolean()
                .default(false)
                .describe('Preview every request without creating any session'),
        },
        async ({
            tasks,
            source,
            starting_branch,
            automation_mode,
            reason,
            auto_approve,
            poll_interval_ms,
            timeout_ms,
            concurrency,
            dry_run,
        }) => {
            // Guarded here as well as in the schema: a caller that bypasses zod
            // parsing must not get a zero-session success out of an empty list.
            if (!Array.isArray(tasks) || tasks.length === 0) {
                return errorResponse(
                    new JulesAPIError(
                        'tasks must contain at least one entry',
                        400,
                    ),
                );
            }

            // Restate the defaults explicitly rather than leaning on zod's
            // .default(): a caller bypassing schema parsing gets `undefined`
            // here, and `i += undefined` makes the creation loop a silent
            // no-op that reports a clean zero-session run. Caught by the
            // handler-level tests, which is why they drive the handler.
            const limit = concurrency ?? TASK_LIST_CONCURRENCY_CAP;
            const approve = auto_approve ?? true;
            const interval = poll_interval_ms ?? 5000;
            const budgetMs = timeout_ms ?? 600000;
            const preview = dry_run === true;

            const resolved = tasks.map((t) => ({
                prompt: t.prompt,
                title: t.title,
                source: normalizeResourceName(t.source ?? source, 'sources'),
                startingBranch: t.starting_branch ?? starting_branch,
                automationMode: t.automation_mode ?? automation_mode,
            }));

            // #50432: bound WHICH repos this may touch BEFORE anything is
            // created. dry_run is a preview, not an exemption. Every distinct
            // effective source is checked, and ONE denied entry refuses the
            // whole call rather than creating a half-batch.
            const allowlist = process.env.JULES_ALLOWED_REPOS;
            for (const entry of resolved) {
                const gate = checkSourceAllowed(entry.source, allowlist);
                if (!gate.allowed) {
                    await emitAudit({
                        source: 'jules-mcp',
                        category: 'coding-task',
                        action: 'DENY',
                        service: entry.source,
                        reason,
                        payload: {
                            denied_by: 'allowlist',
                            repo: gate.repo,
                            mode: 'run_tasks',
                        },
                    });
                    return errorResponse(new JulesAPIError(gate.message, 403));
                }
            }

            const bodies = resolved.map((e) => ({
                prompt: e.prompt,
                sourceContext: {
                    source: e.source,
                    githubRepoContext: { startingBranch: e.startingBranch },
                },
                title: e.title,
                requirePlanApproval: true,
                automationMode: e.automationMode,
            }));

            if (preview) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    status: 'DRY_RUN',
                                    dry_run: true,
                                    count: bodies.length,
                                    would_request: bodies.map((body) => ({
                                        method: 'POST',
                                        url: '/v1alpha/sessions',
                                        body,
                                    })),
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            }

            // --- Create, bounded by `concurrency`, isolating per-entry errors ---
            const created: {
                entry: (typeof resolved)[number];
                session: Session;
            }[] = [];
            const failed: {
                index: number;
                prompt: string;
                error: string;
            }[] = [];

            for (let i = 0; i < resolved.length; i += limit) {
                const chunk = resolved.slice(i, i + limit);
                await Promise.all(
                    chunk.map(async (entry, j) => {
                        const index = i + j;
                        try {
                            const session = await client.createSession(
                                bodies[index],
                            );
                            created.push({ entry, session });
                            // One audit record per created session, which is
                            // the tool's stated contract.
                            await emitAudit({
                                source: 'jules-mcp',
                                category: 'coding-task',
                                action: 'POST',
                                service: entry.source,
                                reason,
                                target: session.id,
                                payload: {
                                    prompt: entry.prompt,
                                    title: entry.title,
                                    mode: 'run_tasks',
                                },
                            });
                        } catch (error) {
                            failed.push({
                                index,
                                prompt: entry.prompt,
                                error: String(error),
                            });
                        }
                    }),
                );
            }

            // --- Poll everything that was created, isolating per-session failures ---
            const deadline = Date.now() + budgetMs;
            const outcomes = await Promise.all(
                created.map((c) =>
                    pollToCompletion(client, c.session, {
                        autoApprove: approve,
                        pollIntervalMs: interval,
                        deadline,
                        normalizedSource: c.entry.source,
                        reason,
                    }).catch((error): PollOutcome => ({
                        outcome: 'error',
                        session: c.session,
                        error: String(error),
                    })),
                ),
            );

            const results = outcomes.map((o) => ({
                id: o.session.id,
                state: o.session.state,
                url: o.session.url,
                title: o.session.title,
                outcome: o.outcome,
                note: outcomeNote(o),
            }));
            const completed = outcomes.filter(
                (o) => o.outcome === 'terminal',
            ).length;
            // PARTIAL covers both "some sessions could not be created" and
            // "some were created but did not reach a terminal state" — the
            // caller has to read `failed` and the per-session outcomes either
            // way, so a separate status would not change the reading.
            const status =
                failed.length > 0 || completed !== results.length
                    ? 'PARTIAL'
                    : 'OK';

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                status,
                                message:
                                    `${created.length}/${resolved.length} sessions created; ` +
                                    `${completed}/${results.length} reached a terminal state` +
                                    (failed.length
                                        ? `; ${failed.length} could not be created`
                                        : '') +
                                    '.',
                                sessions: results,
                                failed,
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
