import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import { formatActivity } from '../formatters.js';
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
            page_token: z.string().optional().describe('Pagination token'),
        },
        async ({ session_id, page_size, page_token }) => {
            try {
                const result = await client.listActivities(
                    session_id,
                    page_size,
                    page_token,
                );
                const text = result.activities.map(formatActivity).join('\n\n');
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
                            text: formatActivity(activity),
                        },
                    ],
                };
            } catch (error) {
                return errorResponse(error);
            }
        },
    );
}
