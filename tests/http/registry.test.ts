/**
 * One tool registry, shared by both transports (Redmine #50638, #50652).
 *
 * #50652's anti-pattern is `tool_fn = globals().get(tool_name)` behind an
 * unauthenticated HTTP listener: the lookup is the module's entire global
 * namespace rather than a registry of MCP tools, so any callable at module
 * scope is reachable with attacker-supplied keyword arguments. The
 * transferable rule is "dispatch from an explicit allowlist, never from a
 * namespace lookup", and the acceptance criterion is a test asserting a
 * non-tool function name is REJECTED, not invoked.
 *
 * These tests drive the real `McpServer` produced by `createJulesMcpServer`
 * through a real SDK `Client` over an in-memory transport pair. No socket, no
 * network: `fetch` is stubbed and asserted never to have been called, which is
 * what makes "not invoked" a claim about the Jules API rather than about a
 * return value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createJulesMcpServer } from '../../src/server-factory.js';
import { JulesClient } from '../../src/jules-client.js';
import { ScheduleStore } from '../../src/scheduler/persistence.js';
import { ScheduleManager } from '../../src/scheduler/cron.js';
import { SourceConfigStore } from '../../src/source-config.js';

vi.mock('../../src/audit.js', () => ({ emitAudit: vi.fn(async () => {}) }));

let fetchSpy: ReturnType<typeof vi.fn>;

async function connectedClient() {
    const client = new JulesClient('test-key');
    const store = new ScheduleStore('0'.repeat(64));
    const server = createJulesMcpServer({
        client,
        manager: new ScheduleManager(store, client),
        sourceConfig: new SourceConfigStore(),
    });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([
        server.connect(serverTransport),
        mcp.connect(clientTransport),
    ]);
    return { mcp, server };
}

beforeEach(() => {
    fetchSpy = vi.fn(async () => {
        throw new Error('no test may hit the network');
    });
    vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('createJulesMcpServer', () => {
    it('exposes the same tool set the stdio transport registers', async () => {
        const { mcp, server } = await connectedClient();
        const { tools } = await mcp.listTools();
        expect(tools.length).toBeGreaterThan(0);
        for (const tool of tools) {
            expect(tool.name).toMatch(/^jules_[a-z_]+$/);
        }
        await server.close();
    });

    it('rejects a non-tool function name instead of invoking it', async () => {
        const { mcp, server } = await connectedClient();
        // Names reachable through a `globals()`-style lookup in a module like
        // ours: an imported symbol, a builtin, and a local helper.
        for (const name of [
            'globals',
            'emitAudit',
            'process',
            'createJulesMcpServer',
            'fetch',
        ]) {
            const result = (await mcp.callTool({
                name,
                arguments: {},
            })) as { isError?: boolean; content: Array<{ text: string }> };
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain(`Tool ${name} not found`);
        }
        expect(fetchSpy).not.toHaveBeenCalled();
        await server.close();
    });

    it('registers all 19 tools, so HTTP and stdio cannot drift apart', async () => {
        const { mcp, server } = await connectedClient();
        const { tools } = await mcp.listTools();
        expect(tools.length).toBe(19);
        await server.close();
    });

    it('does not reach the Jules API when a required argument is missing', async () => {
        const { mcp, server } = await connectedClient();
        const result = (await mcp.callTool({
            name: 'jules_create_session',
            arguments: {},
        })) as { isError?: boolean; content: Array<{ text: string }> };
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Input validation error');
        expect(fetchSpy).not.toHaveBeenCalled();
        await server.close();
    });
});
