import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import {
    applyCharBudget,
    formatActivity,
    OUTPUT_BUDGETS,
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

export function registerActivityTools(
    server: McpServer,
    client: JulesClient,
): void {
    server.tool(
        'jules_list_activities',
        'List activity log entries for a Jules session — messages, plans, progress updates, and results',
        {
            session_id: z.string().describe('Session ID or full resource name'),
            page_size: z
                .number()
                .optional()
                .describe('Number of activities to return'),
            page_token: z
                .string()
                .optional()
                .describe(
                    'Pagination token from a previous response. This is a nanoseconds-since-epoch cursor meaning "the first activity at or after time T", so it can also be constructed directly to seek to a timestamp instead of paging through full diffs to reach it — e.g. 1787346421522664000 is 2026-08-21T21:07:01.522664Z. Activities come back oldest-first.',
                ),
        },
        async ({ session_id, page_size, page_token }) => {
            try {
                const result = await client.listActivities(
                    session_id,
                    page_size,
                    page_token,
                );
                // #50417: budget per item, naming the drill-down that expands
                // it, then budget the page as a whole and name the paging call.
                const text = result.activities
                    .map((a) =>
                        applyCharBudget(
                            formatActivity(a),
                            OUTPUT_BUDGETS.listItem,
                            `jules_get_activity with session_id="${session_id}" and activity_id="${a.id}"`,
                        ),
                    )
                    .join('\n\n');
                const budgeted = applyCharBudget(
                    text,
                    OUTPUT_BUDGETS.listPage,
                    result.nextPageToken
                        ? `jules_list_activities with session_id="${session_id}" and page_token="${result.nextPageToken}"`
                        : `jules_list_activities with session_id="${session_id}" and a larger page_size`,
                );
                const response: any = {
                    status: 'OK',
                    count: result.activities.length,
                };
                if (result.nextPageToken)
                    response.nextPageToken = result.nextPageToken;
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `${JSON.stringify(response)}\n\n${budgeted}`,
                        },
                    ],
                };
            } catch (error) {
                return errorResponse(error);
            }
        },
    );

    server.tool(
        'jules_get_activity',
        'Get a single activity with full details including artifacts (code changes, patches, command output)',
        {
            session_id: z.string().describe('Session ID or full resource name'),
            activity_id: z.string().describe('Activity ID'),
        },
        async ({ session_id, activity_id }) => {
            try {
                const activity = await client.getActivity(
                    session_id,
                    activity_id,
                );
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: applyCharBudget(
                                formatActivity(activity),
                                OUTPUT_BUDGETS.detail,
                                // No fuller view exists for a single activity,
                                // so the message says so rather than implying a
                                // retry that cannot work (#50417).
                                null,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return errorResponse(error);
            }
        },
    );
}
