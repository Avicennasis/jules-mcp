import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import {
    formatSessionDiff,
    summarizeSessionDiff,
    extractPatch,
} from '../formatters.js';
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

export function registerDiffTools(
    server: McpServer,
    client: JulesClient,
): void {
    server.tool(
        'jules_get_session_diff',
        'Get a consolidated, review-friendly view of a session: its plan and the final code changeset (binary blobs omitted). Use this to review what Jules actually changed before approving or opening a PR. Set summary=true for a files-and-line-counts overview instead of the full diff.',
        {
            session_id: z.string().describe('Session ID or full resource name'),
            summary: z
                .boolean()
                .default(false)
                .describe(
                    'Return a compact summary (files changed, +/- line counts, commit message) instead of the full diff. Use for large changesets or quick triage.',
                ),
            include_lockfiles: z
                .boolean()
                .default(false)
                .describe(
                    'Include lockfile diffs (pnpm-lock.yaml, package-lock.json, yarn.lock, etc.) in the output. Default false — lockfiles are excluded to keep output readable.',
                ),
        },
        async ({ session_id, summary, include_lockfiles }) => {
            try {
                const session = await client.getSession(session_id);
                const { activities } = await client.listActivities(
                    session_id,
                    200,
                );
                const text = summary
                    ? summarizeSessionDiff(session, activities)
                    : formatSessionDiff(session, activities, {
                          includeLockfiles: include_lockfiles,
                      });
                return {
                    content: [{ type: 'text' as const, text }],
                };
            } catch (error) {
                return errorResponse(error);
            }
        },
    );

    server.tool(
        'jules_pull_session',
        "Extract the final code changeset from a completed session as a git-apply-ready unified diff patch. Use this to apply Jules's changes to a local checkout. Returns the raw patch, suggested commit message, and a file summary.",
        {
            session_id: z.string().describe('Session ID or full resource name'),
            include_lockfiles: z
                .boolean()
                .default(false)
                .describe(
                    'Include lockfile diffs in the patch output. Default false — lockfiles are excluded to keep output manageable.',
                ),
        },
        async ({ session_id, include_lockfiles }) => {
            try {
                const session = await client.getSession(session_id);
                const { activities } = await client.listActivities(
                    session_id,
                    200,
                );
                const result = extractPatch(activities, {
                    includeLockfiles: include_lockfiles,
                });

                if (!result) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify({
                                    status: 'OK',
                                    session_id: session.id,
                                    state: session.state,
                                    hasChanges: false,
                                    message:
                                        'Session produced no code changes (plan only).',
                                }),
                            },
                        ],
                    };
                }

                const filesSummary = result.files
                    .map(
                        (f) =>
                            `  ${f.file}  (+${f.insertions}/-${f.deletions})`,
                    )
                    .join('\n');

                const headerParts = [
                    `Session: ${session.title ?? session.id}`,
                    `State: ${session.state}`,
                    `Source: ${session.sourceContext.source}`,
                    result.commitMessage
                        ? `Commit message: ${result.commitMessage}`
                        : null,
                    `Files (${result.files.length}):`,
                    filesSummary,
                ];

                if (result.excludedLockfiles?.length) {
                    headerParts.push('');
                    headerParts.push(
                        `Lockfiles excluded (${result.excludedLockfiles.length}): ${result.excludedLockfiles.join(', ')}`,
                    );
                    headerParts.push(
                        'Use include_lockfiles=true to include them.',
                    );
                }

                headerParts.push(
                    '',
                    '--- patch (pipe to `git apply` or `git apply --3way`) ---',
                    '',
                );

                const header = headerParts
                    .filter((l) => l !== null)
                    .join('\n');

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: header + result.patch,
                        },
                    ],
                };
            } catch (error) {
                return errorResponse(error);
            }
        },
    );
}
