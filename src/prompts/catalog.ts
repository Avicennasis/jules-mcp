/**
 * The prompt catalog — reusable Jules task templates (Redmine #50429).
 *
 * WHY THESE LIVE IN SOURCE, unlike `guidance.md`. Standing guidance is one
 * editable knob whose entire purpose is to change house rules without a
 * release, and a missing file there means "use the default". A catalog is
 * different in kind: its entries are *advertised* over `prompts/list`, so
 * loading it from the config dir would make the prompt list vary per machine
 * and let a typo'd file silently reduce a client's slash-command menu to
 * nothing. These ship with the release, are type-checked, formatted and
 * tested, and change through a reviewed diff.
 *
 * DRAFTING RULES, both from the ticket:
 *
 * - Scope is stated by POSITIVE ENCLOSURE ("ONLY modify X") rather than as a
 *   list of prohibitions. Negative constraint lists cause attention drag —
 *   naming a thing to leave alone puts it in front of the model. Guarded by a
 *   test that scans these bodies for negative-constraint phrasing.
 * - Bodies carry NO standing guidance. `jules_create_session` prepends
 *   `loadGuidance()` at creation time; a template that embedded it would ship
 *   it twice. The task footer says so out loud so a reader of the rendered
 *   prompt knows where the guidance went.
 *
 * Placeholder forms are `<NAME>` for operator-supplied identifiers and
 * `[[NAME]]` for externally-sourced text that must be nonce-fenced. Both are
 * discovered by scanning the body; see src/prompts/template.ts.
 */

import type { PromptTemplate } from './template.js';

/**
 * Appended to every `task` template. It carries `<SOURCE>` and
 * `<STARTING_BRANCH>`, so those become derived arguments of every task prompt
 * without any template restating them — composition happens before derivation,
 * which is the point.
 */
const TASK_FOOTER = `## Running this task

Create this with \`jules_create_session\` (or \`jules_run_task\`) against source \`<SOURCE>\`, starting branch \`<STARTING_BRANCH>\`, and a \`reason\` for the audit log. Send everything above as the \`prompt\` exactly as it stands: this server prepends its standing guidance at creation time, so the text above stays free of it.`;

/** Appended to every `operation` template — these drive this server's tools. */
const OPERATION_FOOTER = `## Running this workflow

Work the steps above with this server's tools, supplying a \`reason\` on every mutation for the audit log. This workflow drives the server directly, so it needs a session of its own only where a step says to create one.`;

function task(
    name: string,
    title: string,
    description: string,
    instructions: string,
): PromptTemplate {
    return {
        name,
        kind: 'task',
        title,
        description: `${description} Rendered for the \`prompt\` argument of jules_create_session, which prepends standing guidance.`,
        body: `${instructions}\n\n${TASK_FOOTER}`,
    };
}

function operation(
    name: string,
    title: string,
    description: string,
    instructions: string,
): PromptTemplate {
    return {
        name,
        kind: 'operation',
        title,
        description: `${description} Drives this server's own tools rather than creating a Jules task.`,
        body: `${instructions}\n\n${OPERATION_FOOTER}`,
    };
}

export const PROMPT_CATALOG: readonly PromptTemplate[] = [
    task(
        'add-tests-for-module',
        'Add tests for a module',
        'Cover a single module with tests that each fail when the behaviour they assert is removed.',
        `# Add tests for \`<MODULE_PATH>\`

## Scope
ONLY add or extend tests covering \`<MODULE_PATH>\`. Leave that module's own source exactly as it stands; where a test can pass only by editing the module, report it as a finding and stop.

## What to do
1. Read \`<MODULE_PATH>\` and list the behaviours it promises: return shapes, error paths, boundary values, and any invariant its comments state.
2. For each behaviour write one test that goes red when that behaviour is removed. Prove it: break the behaviour on purpose, watch the new test fail, restore, watch it pass.
3. Put the tests where this repository already keeps tests for that module, matching the existing file naming and framework.
4. Run \`<TEST_COMMAND>\` and leave the suite green.

## Report
State the final test count, name each behaviour you covered, and name each behaviour you left uncovered together with the reason.`,
    ),

    task(
        'fix-failing-ci',
        'Fix a failing CI workflow',
        'Diagnose a CI failure from its log and apply the smallest fix that addresses the mechanism.',
        `# Fix the failing \`<WORKFLOW_NAME>\` workflow

## Scope
ONLY change what is required to make \`<WORKFLOW_NAME>\` pass. Every behaviour the suite already asserts stays intact.

## What to do
1. Read the failure output supplied as [[FAILURE_LOG]] and name the first genuine failure — the earliest one that is a cause rather than a consequence of an earlier one.
2. Trace it to the line of source that produces it, and state the mechanism in one sentence before editing anything.
3. Apply the smallest fix that addresses that mechanism, then re-run the failing job locally where the repository offers a way to.
4. Where the log shows several independent failures, fix them one at a time, re-running between fixes.

## Report
Name the root cause, the file and line you changed, and the evidence that the job now passes. Where the log points at infrastructure rather than at the code, say so and stop.`,
    ),

    task(
        'upgrade-dependency',
        'Upgrade a dependency',
        'Move one package to a target version and adapt only the call sites the upgrade forces to change.',
        `# Upgrade \`<PACKAGE_NAME>\` to \`<TARGET_VERSION>\`

## Scope
ONLY touch the dependency manifest, the lockfile, and the call sites the upgrade forces to change.

## What to do
1. Read the release notes supplied as [[RELEASE_NOTES]] and list every breaking change between the version in the manifest and \`<TARGET_VERSION>\`.
2. Update the manifest and regenerate the lockfile with this repository's package manager.
3. For each breaking change on your list, find its call sites here and adapt them. Where a change has no call site in this repository, say so explicitly.
4. Run the full test suite and the build, and leave both green.

## Report
Give the version delta, the breaking changes that actually applied to this repository, and every file you adapted.`,
    ),

    task(
        'refactor-for-readability',
        'Refactor a module for readability',
        'Restructure one module behind an unchanged public interface, preserving rationale comments verbatim.',
        `# Refactor \`<MODULE_PATH>\` for readability

## Scope
ONLY restructure \`<MODULE_PATH>\`. Its public interface and its observable behaviour stay identical, so the existing tests pass unchanged.

## What to do
1. Read the module and name the three things that make it hardest to follow — long functions, duplicated branches, names describing the mechanism where they could describe the intent.
2. Address them one at a time, running \`<TEST_COMMAND>\` after each step so any regression is attributable to a single change.
3. Keep every comment explaining WHY. Rationale, invariants, concurrency reasoning and security posture survive word for word, even where the code around them moves.
4. Where a comment restates WHAT the code does and the restructured code says it plainly, remove that comment.

## Report
List each change with the reason it improves readability, and confirm the suite passed after every step.`,
    ),

    task(
        'write-missing-docs',
        'Document a module',
        'Derive documentation from the code itself, treating existing prose as a claim to verify.',
        `# Document \`<MODULE_PATH>\` in \`<DOC_FILE>\`

## Scope
ONLY write documentation: \`<DOC_FILE>\` and doc comments inside \`<MODULE_PATH>\`. The module's executable behaviour stays identical.

## What to do
1. Read \`<MODULE_PATH>\` and derive what it does from the code itself, treating any prose already present as a claim to verify.
2. In \`<DOC_FILE>\`, describe the module's purpose, its public surface with each parameter and return value, and at least one worked example checked against the real signatures.
3. Record the failure modes: what each error path means and what a caller should do about it.
4. Where the code and an existing sentence disagree, correct the sentence and name it in your report.

## Report
List every claim you wrote that you verified against the code, and every claim you left out because the code stopped short of supporting it.`,
    ),

    operation(
        'triage-stale-sessions',
        'Triage stale Jules sessions',
        'Classify sessions idle beyond a threshold and archive the ones the operator names back.',
        `# Triage Jules sessions idle for more than <STALE_AFTER_HOURS> hours

## Scope
ONLY inspect sessions, and archive the ones the operator names back to you. Every session still making progress stays exactly where it is.

## What to do
1. Call \`jules_list_sessions\` and collect every session whose \`updateTime\` is older than <STALE_AFTER_HOURS> hours.
2. For each one call \`jules_get_session\` and classify it: awaiting plan approval, awaiting feedback, failed, or silently idle.
3. Report the classifications to the operator and ask which to archive. Archive only the ones named back to you, via \`jules_archive_session\`, with a \`reason\` stating the classification.
4. Treat a session already in a terminal state as settled and leave it as it stands.

## Report
Give a table of session id, state, hours idle, classification, and the action taken.`,
    ),

    operation(
        'review-session-diff',
        'Review a session diff before approving',
        'Read a session patch hunk by hunk and return an approve / revise / reject verdict for the operator.',
        `# Review the diff from Jules session <SESSION_ID> before approving

## Scope
ONLY read and report. Approving, messaging and archiving stay with the operator, who decides after reading your report.

## What to do
1. Call \`jules_get_session_diff\` for <SESSION_ID> and read the whole patch.
2. Record the \`base <sha7>\` in the change summary. That is the commit the session pinned at creation and re-applies from; where it sits behind the current branch head, say so loudly — merging can revert everything landed since.
3. Go through the patch hunk by hunk and flag: behaviour changes beyond what the task asked for, deleted comments that explained WHY, secrets or credentials, widened permissions, and new dependencies.
4. Check that the tests in the patch would fail with the change reverted, as far as reading them allows.

## Report
Give a verdict of approve, revise or reject, naming the hunk that drives it. For a revise verdict, write the exact message to send with \`jules_send_message\`, remembering that plan approval carries forward across revisions — so revise while the gate is still closed.`,
    ),
];
