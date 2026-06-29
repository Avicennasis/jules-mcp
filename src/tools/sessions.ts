import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import type { Session } from '../types.js';
import { normalizeResourceName } from '../types.js';
import { emitAudit } from '../audit.js';
import {
    formatSession,
    formatSessionCompact,
    summarizeChangeset,
    changeSummaryLine,
    detectDuplicates,
    type ChangeSummary,
} from '../formatters.js';
import { JulesAPIError, JulesStateError } from '../errors.js';

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

export function registerSessionTools(
    server: McpServer,
    client: JulesClient,
): void {
    server.tool(
        'jules_create_session',
        'Create a new Jules coding task. Requires a prompt, source repo, and branch.',
        {
            prompt: z.string().describe('What Jules should do'),
            source: z
                .string()
                .describe('Source name (e.g. "sources/github/owner/repo")'),
            starting_branch: z
                .string()
                .describe('Branch to start from (e.g. "main")'),
            title: z.string().optional().describe('Optional session title'),
            require_plan_approval: z
                .boolean()
                .default(true)
                .describe(
                    'Require plan approval before execution (default: true)',
                ),
            automation_mode: z
                .enum(['AUTOMATION_MODE_UNSPECIFIED', 'AUTO_CREATE_PR'])
                .optional()
                .describe('Set to AUTO_CREATE_PR to auto-create a PR'),
            reason: z
                .string()
                .describe('Why this task is being created (for audit log)'),
            dry_run: z
                .boolean()
                .default(false)
                .describe('Preview the request without executing'),
        },
        async ({
            prompt,
            source,
            starting_branch,
            title,
            require_plan_approval,
            automation_mode,
            reason,
            dry_run,
        }) => {
            const normalizedSource = normalizeResourceName(source, 'sources');
            const body = {
                prompt,
                sourceContext: {
                    source: normalizedSource,
                    githubRepoContext: { startingBranch: starting_branch },
                },
                title,
                requirePlanApproval: require_plan_approval,
                automationMode: automation_mode,
            };

            if (dry_run) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    status: 'DRY_RUN',
                                    dry_run: true,
                                    would_request: {
                                        method: 'POST',
                                        url: '/v1alpha/sessions',
                                        body,
                                    },
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            }

            try {
                const created = await client.createSession(body);
                // The create response often omits state/timestamps (proto3
                // default-value omission). Fetch the full session so callers
                // always see populated fields.
                const session = created.state
                    ? created
                    : await client.getSession(created.name);
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST',
                    service: normalizedSource,
                    reason,
                    target: session.id,
                    payload: { prompt, title },
                });
                return {
                    content: [
                        { type: 'text' as const, text: formatSession(session) },
                    ],
                };
            } catch (error) {
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST_FAIL',
                    service: normalizedSource,
                    reason,
                    payload: { prompt, error: String(error) },
                });
                return errorResponse(error);
            }
        },
    );

    server.tool(
        'jules_list_sessions',
        'List Jules coding sessions. Supports filtering by source repo, a compact one-line-per-session mode, optional change detection, and multi-page scanning. Note: session states in list results may be slightly stale (seconds) compared to get_session due to upstream API propagation delays — use get_session for authoritative state checks on individual sessions.',
        {
            page_size: z
                .number()
                .optional()
                .describe('Number of sessions to return per API page'),
            page_token: z
                .string()
                .optional()
                .describe('Pagination token from a previous response'),
            source: z
                .string()
                .optional()
                .describe(
                    'Filter to sessions whose source matches this value (case-insensitive substring, e.g. "bfr-shift-dashboard" or "owner/repo"). Applied client-side across scanned pages.',
                ),
            compact: z
                .boolean()
                .default(false)
                .describe(
                    'Return a one-line summary per session (state, id, source, title) instead of the full prompt block. Far smaller output for browsing.',
                ),
            detect_changes: z
                .boolean()
                .default(false)
                .describe(
                    'Annotate each returned session with whether it produced code changes and how many files. Costs one extra API call per returned session.',
                ),
            max_pages: z
                .number()
                .optional()
                .describe(
                    'Auto-follow pagination up to this many pages before returning. Defaults to 1, or 10 when `source` is set (to gather matches across pages). Hard-capped at 20.',
                ),
            detect_duplicates: z
                .boolean()
                .default(false)
                .describe(
                    'Flag sessions with similar titles targeting the same repo as potential duplicates. When used with detect_changes, also flags sessions that modify the same files. Annotates output with duplicate markers.',
                ),
        },
        async ({
            page_size,
            page_token,
            source,
            compact,
            detect_changes,
            max_pages,
            detect_duplicates: detectDupes,
        }) => {
            try {
                // When filtering by source, scan more pages by default so matches
                // aren't missed just because they're past page 1.
                const cap = Math.min(max_pages ?? (source ? 10 : 1), 20);

                const collected: Session[] = [];
                let token = page_token;
                let pagesFetched = 0;
                let lastNextToken: string | undefined;
                do {
                    const result = await client.listSessions(page_size, token);
                    collected.push(...result.sessions);
                    lastNextToken = result.nextPageToken;
                    token = result.nextPageToken;
                    pagesFetched++;
                } while (token && pagesFetched < cap);

                const needle = source?.toLowerCase();
                const sessions = needle
                    ? collected.filter((s) =>
                          s.sourceContext.source.toLowerCase().includes(needle),
                      )
                    : collected;

                // Optional change detection — one activities fetch per session,
                // with bounded concurrency to stay friendly to the API.
                const changeMap = new Map<string, ChangeSummary>();
                if (detect_changes && sessions.length) {
                    const CONCURRENCY = 4;
                    for (let i = 0; i < sessions.length; i += CONCURRENCY) {
                        const slice = sessions.slice(i, i + CONCURRENCY);
                        const summaries = await Promise.all(
                            slice.map(async (s) => {
                                try {
                                    const { activities } =
                                        await client.listActivities(s.id, 200);
                                    return [
                                        s.id,
                                        summarizeChangeset(activities),
                                    ] as const;
                                } catch {
                                    return [s.id, undefined] as const;
                                }
                            }),
                        );
                        for (const [id, summary] of summaries) {
                            if (summary) changeMap.set(id, summary);
                        }
                    }
                }

                // Optional duplicate detection
                const dupeMap = detectDupes
                    ? detectDuplicates(sessions, changeMap.size > 0 ? changeMap : undefined)
                    : new Map<string, string[]>();

                const text = sessions
                    .map((s) => {
                        const change = changeMap.get(s.id);
                        const dupes = dupeMap.get(s.id);
                        if (compact) {
                            let line = formatSessionCompact(s, change);
                            if (dupes?.length) {
                                line += `  [dup: ${dupes.join(', ')}]`;
                            }
                            return line;
                        }
                        const block = formatSession(s);
                        const extras: string[] = [];
                        if (change) extras.push(changeSummaryLine(change));
                        if (dupes?.length) {
                            extras.push(
                                `Possible duplicates: ${dupes.join(', ')}`,
                            );
                        }
                        return extras.length
                            ? `${block}\n${extras.join('\n')}`
                            : block;
                    })
                    .join(compact ? '\n' : '\n\n---\n\n');

                const response: Record<string, unknown> = {
                    status: 'OK',
                    count: sessions.length,
                    pagesFetched,
                };
                if (needle) {
                    response.filteredBy = source;
                    response.scanned = collected.length;
                }
                if (lastNextToken) response.nextPageToken = lastNextToken;

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `${JSON.stringify(response)}\n\n${text}`,
                        },
                    ],
                };
            } catch (error) {
                return errorResponse(error);
            }
        },
    );

    server.tool(
        'jules_get_session',
        'Get the current status of a Jules session',
        {
            session_id: z.string().describe('Session ID or full resource name'),
        },
        async ({ session_id }) => {
            try {
                const session = await client.getSession(session_id);
                return {
                    content: [
                        { type: 'text' as const, text: formatSession(session) },
                    ],
                };
            } catch (error) {
                return errorResponse(error);
            }
        },
    );

    server.tool(
        'jules_approve_plan',
        'Approve a pending plan in a Jules session. Only valid when state is AWAITING_PLAN_APPROVAL.',
        {
            session_id: z.string().describe('Session ID or full resource name'),
            reason: z
                .string()
                .describe('Why the plan is being approved (for audit log)'),
        },
        async ({ session_id, reason }) => {
            let current: Session | undefined;
            try {
                // Pre-validate state before calling the API
                current = await client.getSession(session_id);
                if (current.state !== 'AWAITING_PLAN_APPROVAL') {
                    throw new JulesStateError('approve_plan', current.state);
                }

                const session = await client.approvePlan(session_id);
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST',
                    service: session.sourceContext.source,
                    reason,
                    target: session.id,
                });
                return {
                    content: [
                        { type: 'text' as const, text: formatSession(session) },
                    ],
                };
            } catch (error) {
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST_FAIL',
                    service: current?.sourceContext?.source ?? session_id,
                    reason,
                    payload: { error: String(error) },
                });
                return errorResponse(error);
            }
        },
    );

    server.tool(
        'jules_send_message',
        'Send a message or feedback to a Jules session',
        {
            session_id: z.string().describe('Session ID or full resource name'),
            message: z.string().describe('Message to send to Jules'),
            reason: z
                .string()
                .describe('Why this message is being sent (for audit log)'),
        },
        async ({ session_id, message, reason }) => {
            try {
                const session = await client.sendMessage(session_id, message);
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST',
                    service: session.sourceContext.source,
                    reason,
                    target: session.id,
                    payload: { message },
                });
                return {
                    content: [
                        { type: 'text' as const, text: formatSession(session) },
                    ],
                };
            } catch (error) {
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST_FAIL',
                    service: session_id,
                    reason,
                    payload: { message, error: String(error) },
                });
                return errorResponse(error);
            }
        },
    );

    server.tool(
        'jules_archive_session',
        'Archive a Jules session to close it out and hide it from the active list. Reversible via jules_unarchive_session.',
        {
            session_id: z.string().describe('Session ID or full resource name'),
            reason: z
                .string()
                .describe('Why this session is being archived (for audit log)'),
        },
        async ({ session_id, reason }) => {
            try {
                const session = await client.archiveSession(session_id);
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST',
                    service: session.sourceContext.source,
                    reason,
                    target: session.id,
                    payload: { archived: true },
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: formatSession(session, {
                                includePrompt: false,
                            }),
                        },
                    ],
                };
            } catch (error) {
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST_FAIL',
                    service: session_id,
                    reason,
                    payload: { archived: true, error: String(error) },
                });
                return errorResponse(error);
            }
        },
    );

    server.tool(
        'jules_unarchive_session',
        'Unarchive a previously archived Jules session, returning it to the active list.',
        {
            session_id: z.string().describe('Session ID or full resource name'),
            reason: z
                .string()
                .describe(
                    'Why this session is being unarchived (for audit log)',
                ),
        },
        async ({ session_id, reason }) => {
            try {
                const session = await client.unarchiveSession(session_id);
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST',
                    service: session.sourceContext.source,
                    reason,
                    target: session.id,
                    payload: { archived: false },
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: formatSession(session, {
                                includePrompt: false,
                            }),
                        },
                    ],
                };
            } catch (error) {
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'POST_FAIL',
                    service: session_id,
                    reason,
                    payload: { archived: false, error: String(error) },
                });
                return errorResponse(error);
            }
        },
    );

    server.tool(
        'jules_delete_session',
        'Permanently delete a Jules session. IRREVERSIBLE — prefer jules_archive_session unless you truly need to remove it. Requires confirm_destructive=true.',
        {
            session_id: z.string().describe('Session ID or full resource name'),
            reason: z
                .string()
                .describe('Why this session is being deleted (for audit log)'),
            confirm_destructive: z
                .boolean()
                .default(false)
                .describe('Must be true to actually delete (safety guard)'),
        },
        async ({ session_id, reason, confirm_destructive }) => {
            if (!confirm_destructive) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                status: 'CONFIRMATION_REQUIRED',
                                message:
                                    'Deletion is irreversible. Re-call with confirm_destructive=true, or use jules_archive_session instead.',
                            }),
                        },
                    ],
                    isError: true,
                };
            }
            try {
                await client.deleteSession(session_id);
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'DELETE',
                    service: session_id,
                    reason,
                    target: session_id,
                });
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify({
                                status: 'OK',
                                deleted: session_id,
                            }),
                        },
                    ],
                };
            } catch (error) {
                await emitAudit({
                    source: 'jules-mcp',
                    category: 'coding-task',
                    action: 'DELETE_FAIL',
                    service: session_id,
                    reason,
                    payload: { error: String(error) },
                });
                return errorResponse(error);
            }
        },
    );
}
