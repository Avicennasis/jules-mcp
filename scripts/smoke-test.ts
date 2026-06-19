/**
 * Smoke test — hits the real Jules API to verify connectivity.
 * Run with: npm run smoke
 * Requires JULES_API_KEY in environment.
 */

import { JulesClient } from '../src/jules-client.js';

const apiKey = process.env.JULES_API_KEY;
if (!apiKey) {
    console.error('JULES_API_KEY not set');
    process.exit(1);
}

const client = new JulesClient(apiKey);

async function main() {
    let failures = 0;
    console.log('=== Jules MCP Smoke Test ===\n');

    // Test 1: List sources
    console.log('1. Listing sources...');
    try {
        const sources = await client.listSources();
        console.log(`   Found ${sources.length} source(s)`);
        for (const s of sources) {
            console.log(`   - ${s.name}`);
        }
    } catch (error) {
        console.error(`   FAILED: ${error}`);
        failures++;
    }

    // Test 2: List sessions
    console.log('\n2. Listing recent sessions...');
    try {
        const { sessions } = await client.listSessions(5);
        console.log(`   Found ${sessions.length} session(s)`);
        for (const s of sessions) {
            console.log(
                `   - ${s.id}: ${s.state} — ${s.title ?? s.prompt.slice(0, 50)}`,
            );
        }
    } catch (error) {
        console.error(`   FAILED: ${error}`);
        failures++;
    }

    console.log('\n=== Smoke test complete ===');
    if (failures > 0) {
        console.error(`${failures} test(s) failed`);
        process.exit(1);
    }
}

main().catch(console.error);
