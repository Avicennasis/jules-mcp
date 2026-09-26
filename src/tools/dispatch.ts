import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import {
    dispatchLogPath,
    readDispatches,
    type DispatchEntry,
    type DispatchSession,
} from '../dispatch-log.js';

/**
 * `jules_list_dispatches` — read back what this server created (#50646).
 *
 * The companion to `src/dispatch-log.ts`: that writes a local record of every
 * dispatched session so it survives context loss; this reads it, so "what did I
 * start, and is it done?" has an answer the model can ask for in one call rather
 * than reconstructing ten ids from a compacted conversation.
 */
export function registerDispatchTools(
    server: McpServer,
    client: JulesClient,
): void {
    server.tool(
        'jules_list_dispatches',
        'List sessions this server dispatched (jules_run_task, single or parallel), newest batch first, from the local dispatch log. Survives context loss. Set check_status to re-read each session from Jules for its current state ("is it done?").',
        {
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(10)
                .describe('Maximum dispatch batches to return, newest first'),
            batch_id: z
                .string()
                .optional()
                .describe('Return only this batch id'),
            check_status: z
                .boolean()
                .default(false)
                .describe(
                    'Re-read every session from Jules for its CURRENT state (one API call per session)',
                ),
        },
        async ({ limit, batch_id, check_status }) => {
            const log = dispatchLogPath();
            const all = readDispatches(log);
            const selected = batch_id
                ? all.filter((e) => e.batchId === batch_id)
                : all;
            // Newest first, bounded. `readDispatches` returns oldest-first
            // (append order), so take the tail then reverse.
            const newestFirst = selected.slice(-limit).reverse();

            const dispatches: Array<
                Omit<DispatchEntry, 'sessions'> & {
                    sessions: DispatchSession[];
                }
            > = [];
            for (const batch of newestFirst) {
                const sessions: DispatchSession[] = [];
                for (const s of batch.sessions) {
                    if (!check_status) {
                        sessions.push(s);
                        continue;
                    }
                    try {
                        const live = await client.getSession(s.id);
                        sessions.push({ ...s, state: live.state });
                    } catch (error) {
                        // Keep the recorded state and say the check failed,
                        // rather than dropping the session from the answer.
                        sessions.push({
                            ...s,
                            state: `${s.state} (status check failed: ${
                                error instanceof Error
                                    ? error.message
                                    : String(error)
                            })`,
                        });
                    }
                }
                dispatches.push({ ...batch, sessions });
            }

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                status: 'OK',
                                log,
                                total_batches: selected.length,
                                returned: dispatches.length,
                                dispatches,
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
