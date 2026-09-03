import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import {
    formatSessionDiff,
    summarizeSessionDiff,
    extractPatch,
    suggestBranchName,
    extractReviewContext,
    detectTestFrameworkConflicts,
    detectCommentOnlyChanges,
    extractQualitySignals,
    UNKNOWN_SOURCE,
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
            include_journal_files: z
                .boolean()
                .default(true)
                .describe(
                    'Include .jules/ journal file diffs (sentinel.md, palette.md) in the output. Default true for review context. Set false to strip them.',
                ),
        },
        async ({
            session_id,
            summary,
            include_lockfiles,
            include_journal_files,
        }) => {
            try {
                const session = await client.getSession(session_id);
                const { activities } = await client.listActivities(
                    session_id,
                    200,
                );
                let text = summary
                    ? summarizeSessionDiff(session, activities)
                    : formatSessionDiff(session, activities, {
                          includeLockfiles: include_lockfiles,
                          includeJournalFiles: include_journal_files,
                      });

                // Scan for review warnings and quality signals
                const { rawDiff, proseTexts } = extractReviewContext(
                    session,
                    activities,
                );
                const warnings = [
                    ...detectTestFrameworkConflicts(rawDiff),
                    ...detectCommentOnlyChanges(rawDiff),
                ];
                const signals = extractQualitySignals(proseTexts);
                if (warnings.length > 0 || signals.length > 0) {
                    const items: string[] = [];
                    for (const w of warnings) {
                        items.push(`- [${w.type}] ${w.message}`);
                    }
                    for (const s of signals) {
                        items.push(`- [${s.type}] ${s.excerpt}`);
                    }
                    text += `\n\n⚠️ Review warnings:\n${items.join('\n')}`;
                }

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
            include_journal_files: z
                .boolean()
                .default(false)
                .describe(
                    'Include .jules/ journal file diffs in the patch output. Default false — journal files are excluded from patches to avoid merge conflicts when applying multiple session patches to the same repo.',
                ),
        },
        async ({ session_id, include_lockfiles, include_journal_files }) => {
            try {
                const session = await client.getSession(session_id);
                const { activities } = await client.listActivities(
                    session_id,
                    200,
                );
                const result = extractPatch(activities, {
                    includeLockfiles: include_lockfiles,
                    includeJournalFiles: include_journal_files,
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
                    `Source: ${session.sourceContext?.source ?? UNKNOWN_SOURCE}`,
                    `Suggested branch: ${suggestBranchName(session)}`,
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

                if (result.excludedJournalFiles?.length) {
                    headerParts.push('');
                    headerParts.push(
                        `Journal files excluded (${result.excludedJournalFiles.length}): ${result.excludedJournalFiles.join(', ')}`,
                    );
                    headerParts.push(
                        'Use include_journal_files=true to include them.',
                    );
                }

                headerParts.push(
                    '',
                    '--- patch (pipe to `git apply` or `git apply --3way`) ---',
                    '',
                );

                const header = headerParts.filter((l) => l !== null).join('\n');

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
