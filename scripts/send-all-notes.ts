#!/usr/bin/env tsx
import { JulesClient } from '../src/jules-client.js';

const client = new JulesClient(process.env.JULES_API_KEY!);

// session id -> decision note. (8551 already sent.)
const notes: Record<string, string> = {
  // --- ACCEPTED (merged) ---
  '11130330637793513382':
    'Reviewed: ACCEPTED. Strong, policy-aligned security fix (prototype-pollution defense + log redaction). Merged, combined with the content.js log-redaction work from a related session.',
  '5740489096444123107':
    'Reviewed: ACCEPTED. Comprehensive log-redaction sweep; notably removed a debug log that previewed up to 50 chars of live page content. Merged together with the prototype-pollution hardening.',
  '8812730074612297709':
    'Reviewed: ACCEPTED. New safeWordMap test coverage. Merged; one assertion was updated to expect the new prototype-less return value, and all new test files were wired into CI (they were not running before).',
  '985471343551636017':
    'Reviewed: ACCEPTED. Useful additive coverage for estimateStorageSize (empty, ASCII, unicode, multi-rule). Merged.',
  '16903730377720057572':
    'Reviewed: ACCEPTED. Solid coverage for buildRegex (boundaries, longest-match sorting, escaping). Merged.',

  // --- REJECTED: perf micro-opts (against the repo Transparency & Safety policy; most were plan-only) ---
  '13238938389733204467':
    'Reviewed: NOT TAKEN. Per the repo Transparency & Safety policy, readability for non-developers is prioritized over micro-optimization. Caching toLowerCase results as hidden state on DOM rows trades that away for a negligible gain on a small list. (Session produced a plan only.)',
  '5675344517427493899':
    'Reviewed: NOT TAKEN. Caches one-time DOMContentLoaded getElementById lookups (not a hot path) and threads a DOM element through importRules for an imperceptible gain. Conflicts with the readability-first policy. (Plan only.)',
  '17710019724868742223':
    'Reviewed: NOT TAKEN. DOM-clear micro-opt on table rebuilds (not a hot path); the explicit removeChild loop is the documented-safe idiom, and the repo policy forbids innerHTML. (Plan only.)',
  '3163795034866504814':
    'Reviewed: NOT TAKEN. Redundant-query micro-opt in filterRules; negligible benefit vs. the readability-first policy. (Plan only.)',
  '12789605781156781930':
    'Reviewed: NOT TAKEN. Search-filter micro-opt; same rationale as the other perf suggestions under the readability-first policy. (Plan only.)',

  // --- REJECTED: intentional/documented code removals ---
  '16574181115320850452':
    'Reviewed: NOT TAKEN. The chrome.browserAction fallback is intentional, documented code: the comment explicitly states it is retained as a zero-cost safety net for a possible MV2 backport. Removing it (and its rationale comment) conflicts with the Transparency & Safety policy.',
  '6651362786789259043':
    'Reviewed: NOT TAKEN. Duplicate of the browserAction-fallback removal; that fallback is intentional, documented code and is kept on purpose.',
  '8248698190983518599':
    'Reviewed: NOT TAKEN. Duplicate of the browserAction-fallback removal; the fallback is retained intentionally as a documented MV2 safety net.',

  // --- REJECTED: superseded / conflicting / non-issue ---
  '16869012434777911275':
    'Reviewed: NOT TAKEN (superseded). The JSON.parse reviver here is a subset of a more comprehensive prototype-pollution fix that was merged instead.',
  '15026362007315650407':
    'Reviewed: NOT TAKEN (conflicts). Nice decomposition of validateImportedRules, but it conflicts with the merged security-hardening rewrite of the same function, which was prioritized.',
  '13326400489543807976':
    'Reviewed: NOT TAKEN. validateStorageQuota is already covered by existing unit tests, and the proposed version required weakening production const declarations to let purely for test access.',
  '12632040276988873622':
    'Reviewed: NOT TAKEN. The comment correctly explains why the deprecated HTML width attribute is avoided; removing that explanation makes the code less self-documenting, against the Transparency & Safety policy. No actual deprecated code exists.',
};

let ok = 0;
let fail = 0;
for (const [id, note] of Object.entries(notes)) {
  try {
    await client.sendMessage(id, note);
    console.log(`OK  ${id}`);
    ok++;
  } catch (e) {
    console.log(`ERR ${id}: ${(e as Error).message}`);
    fail++;
  }
}
console.log(`\nDone: ${ok} sent, ${fail} failed.`);
