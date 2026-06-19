#!/usr/bin/env tsx
/**
 * Show a consolidated, review-friendly view of one Jules session:
 * the plan, agent progress, and every code changeset (text patches only —
 * binary blobs like .pyc are summarized, not dumped).
 *
 * Usage: tsx scripts/show-session-diff.ts <session_id>
 */

import { JulesClient } from '../src/jules-client.js';
import type { Activity } from '../src/types.js';

const apiKey = process.env.JULES_API_KEY;
if (!apiKey) {
  console.error('JULES_API_KEY not set');
  process.exit(1);
}

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('Usage: show-session-diff.ts <session_id>');
  process.exit(1);
}

const client = new JulesClient(apiKey);

const session = await client.getSession(sessionId);
console.log(`Title:  ${session.title ?? '(none)'}`);
console.log(`State:  ${session.state}`);
console.log(`Source: ${session.sourceContext?.source}`);
console.log(`URL:    ${session.url}`);
console.log('');

const { activities } = await client.listActivities(sessionId, 200);

for (const a of activities as Activity[]) {
  if (a.planGenerated) {
    console.log('━━━ PLAN ━━━');
    for (const step of a.planGenerated.plan.steps) {
      console.log(`  ${(step.index ?? 0) + 1}. ${step.title}`);
    }
    console.log('');
  }

  if (a.progressUpdated) {
    console.log(`• ${a.progressUpdated.title}`);
  }

  if (a.artifacts?.length) {
    for (const artifact of a.artifacts) {
      if (artifact.changeSet?.gitPatch) {
        const patch = artifact.changeSet.gitPatch;
        const diff = patch.unidiffPatch ?? '';
        console.log('\n━━━ CHANGESET ━━━');
        if (patch.suggestedCommitMessage) {
          console.log(`Commit: ${patch.suggestedCommitMessage}`);
        }
        console.log(stripBinaryHunks(diff));
        console.log('');
      }
      if (artifact.bashOutput) {
        const bo = artifact.bashOutput;
        console.log(`\n$ ${bo.command}  (exit ${bo.exitCode})`);
        console.log(bo.output.slice(0, 1000));
      }
    }
  }
}

/** Replace GIT binary patch blobs with a one-line summary per file. */
function stripBinaryHunks(diff: string): string {
  const lines = diff.split('\n');
  const out: string[] = [];
  let inBinary = false;
  let binaryFile = '';
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      binaryFile = line.replace('diff --git ', '');
      inBinary = false;
      out.push(line);
      continue;
    }
    if (line.startsWith('GIT binary patch')) {
      inBinary = true;
      out.push(`  [binary file ${binaryFile} — blob omitted]`);
      continue;
    }
    if (inBinary) {
      if (line.trim() === '') inBinary = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
