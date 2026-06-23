#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JulesClient } from './jules-client.js';
import { ScheduleStore } from './scheduler/persistence.js';
import { ScheduleManager } from './scheduler/cron.js';
import { SourceConfigStore } from './source-config.js';
import { registerSourceTools } from './tools/sources.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerActivityTools } from './tools/activities.js';
import { registerSchedulingTools } from './tools/scheduling.js';
import { registerConvenienceTools } from './tools/convenience.js';
import { registerDiffTools } from './tools/diff.js';

const apiKey = process.env.JULES_API_KEY;
if (!apiKey) {
    console.error(
        'JULES_API_KEY environment variable is required. Generate one at https://jules.google/settings',
    );
    process.exit(1);
}

const encryptionKey = process.env.JULES_ENCRYPTION_KEY;

const server = new McpServer({
    name: 'jules-mcp',
    version: '0.2.0',
});

const client = new JulesClient(apiKey);
const store = new ScheduleStore(encryptionKey);
const manager = new ScheduleManager(store, client);
const sourceConfig = new SourceConfigStore();

// Register all tools
registerSourceTools(server, client, sourceConfig);
registerSessionTools(server, client);
registerActivityTools(server, client);
registerSchedulingTools(server, manager);
registerConvenienceTools(server, client);
registerDiffTools(server, client);

// Start scheduler
manager.start();

// Connect transport
const transport = new StdioServerTransport();
await server.connect(transport);

// Graceful shutdown
async function shutdown() {
    manager.stop();
    await server.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
