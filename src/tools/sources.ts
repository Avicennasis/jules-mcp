import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
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

export function registerSourceTools(
    server: McpServer,
    client: JulesClient,
): void {
    server.tool(
        'jules_list_sources',
        'List connected GitHub repositories available for Jules coding tasks',
        {},
        async () => {
            try {
                const sources = await client.listSources();
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                { status: 'OK', sources },
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
        'jules_get_source',
        'Get details for a specific connected source (GitHub repo)',
        {
            source: z
                .string()
                .describe(
                    'Source name or ID (e.g. "github/owner/repo" or "sources/github/owner/repo")',
                ),
        },
        async ({ source }) => {
            try {
                const result = await client.getSource(source);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                { status: 'OK', source: result },
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
}
