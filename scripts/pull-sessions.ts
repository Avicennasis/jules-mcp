#!/usr/bin/env tsx

import { JulesClient } from '../src/jules-client.js';
import type { Session } from '../src/types.js';

const apiKey = process.env.JULES_API_KEY;
if (!apiKey) {
    console.error('JULES_API_KEY not set');
    process.exit(1);
}

const client = new JulesClient(apiKey);

// Paginate through ALL sessions
const allSessions: Session[] = [];
let pageToken: string | undefined;
do {
    const result = await client.listSessions(100, pageToken);
    allSessions.push(...result.sessions);
    pageToken = result.nextPageToken;
    process.stderr.write(`Fetched ${allSessions.length} sessions so far...\n`);
} while (pageToken);

console.log(`\nTotal: ${allSessions.length} sessions\n`);

// Group by source repo
const byRepo = new Map<string, Session[]>();
for (const s of allSessions) {
    const repo = s.sourceContext?.source ?? 'unknown';
    const shortRepo = repo.replace('sources/github/Avicennasis/', '');
    if (!byRepo.has(shortRepo)) byRepo.set(shortRepo, []);
    byRepo.get(shortRepo)!.push(s);
}

// Group by state
const byState = new Map<string, number>();
for (const s of allSessions) {
    byState.set(s.state, (byState.get(s.state) ?? 0) + 1);
}

console.log('=== By State ===');
for (const [state, count] of [...byState.entries()].sort(
    (a, b) => b[1] - a[1],
)) {
    console.log(`  ${state}: ${count}`);
}
console.log('');

console.log('=== By Repo ===');
for (const [repo, sessions] of [...byRepo.entries()].sort(
    (a, b) => b[1].length - a[1].length,
)) {
    const states = new Map<string, number>();
    for (const s of sessions) {
        states.set(s.state, (states.get(s.state) ?? 0) + 1);
    }
    const stateStr = [...states.entries()]
        .map(([s, c]) => `${s}: ${c}`)
        .join(', ');
    console.log(`  ${repo}: ${sessions.length} (${stateStr})`);
}
console.log('');

// Show completed sessions with PRs or ready-to-review
console.log('=== Sessions with PRs ===');
for (const s of allSessions) {
    if (s.outputs?.length) {
        for (const output of s.outputs) {
            if (output.pullRequest) {
                const repo = (s.sourceContext?.source ?? '').replace(
                    'sources/github/Avicennasis/',
                    '',
                );
                console.log(`  [${repo}] ${output.pullRequest.title}`);
                console.log(`    PR: ${output.pullRequest.url}`);
                console.log(`    Jules: ${s.url}`);
                console.log('');
            }
        }
    }
}

// Show all completed sessions grouped by repo for review
console.log('=== Completed Sessions (for review) ===');
for (const [repo, sessions] of [...byRepo.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
)) {
    const completed = sessions.filter((s) => s.state === 'COMPLETED');
    if (completed.length === 0) continue;
    console.log(`\n  ${repo} (${completed.length} completed):`);
    for (const s of completed) {
        const title = s.title ?? s.prompt.slice(0, 80).split('\n')[0];
        const hasPR = s.outputs?.some((o) => o.pullRequest) ? ' [PR]' : '';
        console.log(`    ${title}${hasPR}`);
        console.log(`      ${s.url}`);
    }
}
