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
        {
            page_size: z
                .number()
                .optional()
                .describe('Number of sources to return per page'),
            page_token: z
                .string()
                .optional()
                .describe('Pagination token from a previous response'),
            filter: z
                .string()
                .optional()
                .describe(
                    'AIP-160 filter expression (e.g. \'name=sources/source1 OR name=sources/source2\')',
                ),
            max_pages: z
                .number()
                .optional()
                .describe(
                    'Auto-follow pagination up to this many pages (default 10, max 20). Set to 1 for a single page.',
                ),
        },
        async ({ page_size, page_token, filter, max_pages }) => {
            try {
                const limit = Math.min(max_pages ?? 10, 20);
                const allSources: unknown[] = [];
                let token = page_token;
                let pages = 0;

                do {
                    const result = await client.listSources({
                        pageSize: page_size,
                        pageToken: token,
                        filter,
                    });
                    allSources.push(...result.sources);
                    token = result.nextPageToken;
                    pages++;
                } while (token && pages < limit);

                const response: Record<string, unknown> = {
                    status: 'OK',
                    count: allSources.length,
                    pagesFetched: pages,
                    sources: allSources,
                };
                if (token) {
                    response.nextPageToken = token;
                    response.note = `More sources available — pass this nextPageToken to continue.`;
                }

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(response, null, 2),
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
