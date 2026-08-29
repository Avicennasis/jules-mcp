import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import type { SourceConfigStore } from '../source-config.js';
import { describeSuggestionsQuota } from '../source-config.js';
import { JulesAPIError } from '../errors.js';
import {
    guardPageToken,
    guardPaginationDeadline,
} from '../pagination.js';

/** Hard ceiling on auto-followed pages, regardless of what the caller asks. */
const MAX_PAGE_CAP = 20;

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

/** Strip the "sources/" prefix to get the short ID used in the config store. */
function sourceId(name: string): string {
    return name.replace(/^sources\//, '');
}

export function registerSourceTools(
    server: McpServer,
    client: JulesClient,
    configStore?: SourceConfigStore,
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
                    "AIP-160 filter expression (e.g. 'name=sources/source1 OR name=sources/source2')",
                ),
            max_pages: z
                .number()
                .optional()
                .describe(
                    'Auto-follow pagination up to this many pages (default 10, max 20; default is the 20-page cap when suggestions_only is set, since that filter needs the whole list). Set to 1 for a single page.',
                ),
            suggestions_only: z
                .boolean()
                .default(false)
                .describe(
                    'Filter to only repos with suggestions enabled (tracked in LOCAL config — the Jules API does not expose suggestion state, so this is a local record that can go stale). Useful for checking the suggestions quota (5 repos max). Scans the full source list by default; if the scan is truncated the reported quota is explicitly a lower bound, not a count.',
                ),
            include_branches: z
                .boolean()
                .default(false)
                .describe(
                    'Include the full branch list for every repo. Off by default: branch counts grow without bound as Jules opens task branches, and the list is usually irrelevant to the question being asked. When off, each repo reports `branchCount` and keeps `defaultBranch`.',
                ),
        },
        async ({
            page_size,
            page_token,
            filter,
            max_pages,
            suggestions_only,
            include_branches,
        }) => {
            try {
                // `suggestions_only` filters the WHOLE source list, so a
                // partial scan cannot answer it — stopping early only
                // establishes "no matches in the pages I happened to scan".
                // Default it to the hard cap rather than 10 (#31).
                const limit = suggestions_only
                    ? Math.min(max_pages ?? MAX_PAGE_CAP, MAX_PAGE_CAP)
                    : Math.min(max_pages ?? 10, MAX_PAGE_CAP);
                const allSources: Record<string, unknown>[] = [];
                let token = page_token;
                let pages = 0;
                // Three independent terminations, because this walk decides
                // scan COMPLETENESS for `suggestions_only` (#50645): the page
                // cap below, a repeated-token guard, and a wall-clock deadline.
                const seenTokens = new Set<string>();
                const startedAt = Date.now();

                do {
                    guardPaginationDeadline(startedAt, 'sources');
                    const result = await client.listSources({
                        pageSize: page_size,
                        pageToken: token,
                        filter,
                    });
                    allSources.push(
                        ...(result.sources as Record<string, unknown>[]),
                    );
                    guardPageToken(result.nextPageToken, seenTokens, 'sources');
                    token = result.nextPageToken;
                    pages++;
                } while (token && pages < limit);

                // Annotate each source with local config if available
                if (configStore) {
                    for (const source of allSources) {
                        const id = sourceId(String(source.name ?? ''));
                        const cfg = configStore.get(id);
                        if (cfg) {
                            source.localConfig = cfg;
                        }
                    }
                }

                // Filter to suggestions-enabled repos if requested
                let filtered = allSources;
                if (suggestions_only && configStore) {
                    filtered = allSources.filter((s) => {
                        const cfg = s.localConfig as
                            { suggestionsEnabled?: boolean } | undefined;
                        return cfg?.suggestionsEnabled === true;
                    });
                }

                // Branch lists dominate the payload and grow without bound as
                // Jules opens task branches. Measured across the 474 real
                // connected sources, as this tool actually serializes them:
                // 513,460 chars with branches against 140,410 without — 72.7%
                // of the response, for data that is usually irrelevant to the
                // question. One repo carried 515 branches on its own (#33).
                let branchesOmitted = 0;
                if (!include_branches) {
                    for (const source of filtered) {
                        const repo = source.githubRepo as
                            { branches?: unknown[] } | undefined;
                        if (Array.isArray(repo?.branches)) {
                            branchesOmitted += repo.branches.length;
                            (repo as Record<string, unknown>).branchCount =
                                repo.branches.length;
                            delete (repo as Record<string, unknown>).branches;
                        }
                    }
                }

                const response: Record<string, unknown> = {
                    status: 'OK',
                    count: filtered.length,
                    pagesFetched: pages,
                    sources: filtered,
                };
                if (!include_branches && branchesOmitted > 0) {
                    response.branchesOmitted = `${branchesOmitted} branches omitted across ${filtered.length} sources — pass include_branches: true for the full lists`;
                }
                if (suggestions_only) {
                    Object.assign(
                        response,
                        describeSuggestionsQuota({
                            matched: filtered.length,
                            // A leftover token means the list was not
                            // exhausted, so the count is a lower bound.
                            scanComplete: !token,
                            pagesFetched: pages,
                            updatedAt: filtered.map(
                                (s) =>
                                    (
                                        s.localConfig as
                                            { updatedAt?: string } | undefined
                                    )?.updatedAt,
                            ),
                        }),
                    );
                }
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
                const response: Record<string, unknown> = {
                    status: 'OK',
                    source: result,
                };

                // Annotate with local config if available
                if (configStore) {
                    const id = sourceId(
                        String(
                            (result as Record<string, unknown>).name ?? source,
                        ),
                    );
                    const cfg = configStore.get(id);
                    if (cfg) {
                        response.localConfig = cfg;
                    }
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

    // --- Local source configuration ---

    server.tool(
        'jules_configure_source',
        'Set local metadata for a source that the Jules API does not expose (e.g. whether suggestions are enabled). This is stored locally and annotated onto list/get responses.',
        {
            source: z
                .string()
                .describe('Source name or ID (e.g. "github/owner/repo")'),
            suggestions_enabled: z
                .boolean()
                .optional()
                .describe(
                    'Whether the Jules "suggestions" feature is enabled for this repo in the Jules web UI',
                ),
            notes: z
                .string()
                .optional()
                .describe('Free-form notes about this source'),
        },
        async ({ source, suggestions_enabled, notes }) => {
            if (!configStore) {
                return errorResponse(
                    new Error(
                        'Source config store not initialized — this is a server configuration issue.',
                    ),
                );
            }

            try {
                const update: Record<string, unknown> = {};
                if (suggestions_enabled !== undefined) {
                    update.suggestionsEnabled = suggestions_enabled;
                }
                if (notes !== undefined) {
                    update.notes = notes;
                }

                const config = configStore.set(source, update);

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    status: 'OK',
                                    source: sourceId(source),
                                    config,
                                },
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
        'jules_list_source_configs',
        'List all locally-stored source configurations (suggestions enabled, notes, etc.)',
        {},
        async () => {
            if (!configStore) {
                return errorResponse(
                    new Error('Source config store not initialized.'),
                );
            }

            try {
                const configs = configStore.list();
                const suggestionsEnabled = configs.filter(
                    (c) => c.config.suggestionsEnabled === true,
                );
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    status: 'OK',
                                    count: configs.length,
                                    // This tool reads the local store directly
                                    // rather than scanning the API, so the scan
                                    // is complete by construction — but the
                                    // staleness caveat applies just the same
                                    // (#35).
                                    ...describeSuggestionsQuota({
                                        matched: suggestionsEnabled.length,
                                        scanComplete: true,
                                        updatedAt: suggestionsEnabled.map(
                                            (c) => c.config.updatedAt,
                                        ),
                                    }),
                                    suggestionsRepos: suggestionsEnabled.map(
                                        (c) => c.sourceId,
                                    ),
                                    configs,
                                },
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
