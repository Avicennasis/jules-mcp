/**
 * The one place tools are registered (Redmine #50638).
 *
 * Both transports call this. stdio builds one server for the process; the HTTP
 * transport builds one per MCP session, because an SDK `Server` binds to a
 * single transport. The shared dependencies -- the Jules client, the schedule
 * manager, the source-config store -- are passed in and are singletons, so
 * per-session servers are cheap and the scheduler is still started exactly
 * once by the entrypoint.
 *
 * Keeping this in one function is the structural half of #50652's lesson.
 * Dispatch is an explicit registry (`server.tool(name, ...)`), never a
 * namespace lookup, and there is no second registration path an HTTP request
 * could take that the stdio path does not. If a tool is added it is added for
 * both, and a name that was never registered is not callable on either.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from './jules-client.js';
import type { ScheduleManager } from './scheduler/cron.js';
import type { SourceConfigStore } from './source-config.js';
import { registerSourceTools } from './tools/sources.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerActivityTools } from './tools/activities.js';
import { registerSchedulingTools } from './tools/scheduling.js';
import { registerConvenienceTools } from './tools/convenience.js';
import { registerDiffTools } from './tools/diff.js';
import { VERSION } from './version.js';

export interface JulesServerDeps {
    client: JulesClient;
    manager: ScheduleManager;
    sourceConfig: SourceConfigStore;
}

/** Build a fully-registered MCP server. Does not connect a transport. */
export function createJulesMcpServer(deps: JulesServerDeps): McpServer {
    const server = new McpServer({
        name: 'jules-mcp',
        // Read from package.json, never restated here (#50713).
        version: VERSION,
    });

    registerSourceTools(server, deps.client, deps.sourceConfig);
    registerSessionTools(server, deps.client);
    registerActivityTools(server, deps.client);
    registerSchedulingTools(server, deps.manager);
    registerConvenienceTools(server, deps.client);
    registerDiffTools(server, deps.client);

    return server;
}
