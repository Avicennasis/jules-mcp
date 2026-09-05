#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JulesClient } from './jules-client.js';
import { ScheduleStore } from './scheduler/persistence.js';
import { ScheduleManager } from './scheduler/cron.js';
import { SourceConfigStore } from './source-config.js';
import { createJulesMcpServer } from './server-factory.js';
import { loadHttpConfig, resolveTransportMode } from './http/config.js';
import { startHttpTransport } from './http/server.js';

const apiKey = process.env.JULES_API_KEY;
if (!apiKey) {
    console.error(
        'JULES_API_KEY environment variable is required. Generate one at https://jules.google/settings',
    );
    process.exit(1);
}

const encryptionKey = process.env.JULES_ENCRYPTION_KEY;

const client = new JulesClient(apiKey);
const store = new ScheduleStore(encryptionKey);
const manager = new ScheduleManager(store, client);
const sourceConfig = new SourceConfigStore();
const deps = { client, manager, sourceConfig };

// Start scheduler
manager.start();

// Transport selection. stdio is the default and is unchanged: `npm start`
// with no new environment variables behaves exactly as it did before the HTTP
// transport existed (#50638). HTTP is opt-in via JULES_MCP_TRANSPORT=http or
// --transport http, and refuses to start without JULES_MCP_HTTP_TOKEN.
let shutdown: () => Promise<void>;

try {
    const mode = resolveTransportMode(process.env, process.argv.slice(2));

    if (mode === 'http') {
        const config = loadHttpConfig(process.env);
        const handle = await startHttpTransport({
            config,
            createServer: () => createJulesMcpServer(deps),
        });
        shutdown = async () => {
            manager.stop();
            await handle.close();
        };
    } else {
        const server = createJulesMcpServer(deps);
        await server.connect(new StdioServerTransport());
        shutdown = async () => {
            manager.stop();
            await server.close();
        };
    }
} catch (error) {
    console.error(
        `jules-mcp: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
}

// Graceful shutdown
async function onSignal() {
    await shutdown();
    process.exit(0);
}

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
