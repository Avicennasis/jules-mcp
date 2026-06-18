import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import type { Session } from '../types.js';
import { normalizeResourceName } from '../types.js';
import { emitAudit } from '../audit.js';
import { formatSession } from '../formatters.js';
import { JulesAPIError, JulesStateError } from '../errors.js';

function errorResponse(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          error instanceof JulesAPIError
            ? error.toJSON()
            : { status: 'ERROR', message: String(error), code: 500 },
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
      source: z.string().describe('Source name (e.g. "sources/github/owner/repo")'),
      starting_branch: z.string().describe('Branch to start from (e.g. "main")'),
      title: z.string().optional().describe('Optional session title'),
      require_plan_approval: z.boolean().default(true).describe('Require plan approval before execution (default: true)'),
      automation_mode: z.enum(['AUTOMATION_MODE_UNSPECIFIED', 'AUTO_CREATE_PR']).optional().describe('Set to AUTO_CREATE_PR to auto-create a PR'),
      reason: z.string().describe('Why this task is being created (for audit log)'),
      dry_run: z.boolean().default(false).describe('Preview the request without executing'),
    },
    async ({ prompt, source, starting_branch, title, require_plan_approval, automation_mode, reason, dry_run }) => {
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
              text: JSON.stringify({
                status: 'DRY_RUN',
                dry_run: true,
                would_request: { method: 'POST', url: '/v1alpha/sessions', body },
              }, null, 2),
            },
          ],
        };
      }

      try {
        const session = await client.createSession(body);
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
          content: [{ type: 'text' as const, text: formatSession(session) }],
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
    'List Jules coding sessions with pagination',
    {
      page_size: z.number().optional().describe('Number of sessions to return'),
      page_token: z.string().optional().describe('Pagination token from previous response'),
    },
    async ({ page_size, page_token }) => {
      try {
        const result = await client.listSessions(page_size, page_token);
        const text = result.sessions.map(formatSession).join('\n\n---\n\n');
        const response: any = { status: 'OK', count: result.sessions.length };
        if (result.nextPageToken) response.nextPageToken = result.nextPageToken;
        return {
          content: [
            { type: 'text' as const, text: `${JSON.stringify(response)}\n\n${text}` },
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
          content: [{ type: 'text' as const, text: formatSession(session) }],
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
      reason: z.string().describe('Why the plan is being approved (for audit log)'),
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
          content: [{ type: 'text' as const, text: formatSession(session) }],
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
      reason: z.string().describe('Why this message is being sent (for audit log)'),
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
          content: [{ type: 'text' as const, text: formatSession(session) }],
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
}
