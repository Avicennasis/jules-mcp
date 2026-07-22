import type {
    Session,
    Activity,
    Plan,
    SessionState,
    Artifact,
} from './types.js';

const STATE_DESCRIPTIONS: Record<SessionState, string> = {
    STATE_UNSPECIFIED: 'Unknown state',
    QUEUED: 'Queued — waiting to start',
    PLANNING: 'Planning — Jules is analyzing the task',
    AWAITING_PLAN_APPROVAL:
        'Awaiting plan approval — review and approve the plan to proceed',
    AWAITING_USER_FEEDBACK:
        'Awaiting feedback — Jules needs your input to continue',
    IN_PROGRESS: 'In progress — Jules is working',
    PAUSED: 'Paused',
    FAILED: 'Failed — the task encountered an error',
    COMPLETED: 'Completed successfully',
};

export function describeState(state: SessionState): string {
    return STATE_DESCRIPTIONS[state] ?? `Unknown state: ${state}`;
}

export function truncatePatch(patch: string, maxLines = 50): string {
    const lines = patch.split('\n');
    if (lines.length <= maxLines) {
        return patch;
    }
    const shown = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    return shown.join('\n') + `\n\n... ${remaining} more lines omitted`;
}

export function formatPlan(plan: Plan): string {
    const header = `Plan ${plan.id}:`;
    // proto3 omits `index` when it is 0 (the default int value), so a missing
    // index means step 0. Coerce to 0 before sorting/numbering.
    const steps = [...plan.steps]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((s) => {
            const heading = `${(s.index ?? 0) + 1}. ${s.title}`;
            // description is omitted by proto3 when empty
            return s.description ? `${heading}\n   ${s.description}` : heading;
        })
        .join('\n');
    return `${header}\n${steps}`;
}

/** Per-file insertion/deletion tally parsed from a unified diff. */
export interface FileChange {
    file: string;
    insertions: number;
    deletions: number;
}

/** Lightweight summary of a session's final changeset, derived from activities. */
export interface ChangeSummary {
    hasChanges: boolean;
    changedFiles: number;
    insertions: number;
    deletions: number;
    files: FileChange[];
    commitMessage?: string;
}

/**
 * Summarize the FINAL cumulative changeset across a session's activities
 * without emitting the full diff: which files changed and their +/- line
 * counts. Jules re-reports the cumulative changeset on successive activities,
 * so the last activity carrying changeset artifacts holds the complete final
 * diff. Binary blobs are ignored. Use this for triage and the `hasChanges`
 * signal in listings, where the raw diff would be too large.
 */
export function summarizeChangeset(
    activities: Activity[],
    opts?: { includeLockfiles?: boolean; includeJournalFiles?: boolean },
): ChangeSummary {
    const empty: ChangeSummary = {
        hasChanges: false,
        changedFiles: 0,
        insertions: 0,
        deletions: 0,
        files: [],
    };

    const changeActivities = activities.filter((a) =>
        a.artifacts?.some((art) => art.changeSet?.gitPatch),
    );
    const last = changeActivities[changeActivities.length - 1];
    if (!last?.artifacts) return empty;

    const files: FileChange[] = [];
    let current: FileChange | undefined;
    let commitMessage: string | undefined;
    let insertions = 0;
    let deletions = 0;
    let skippingLockfile = false;
    let skippingJournal = false;

    for (const art of last.artifacts) {
        const gp = art.changeSet?.gitPatch;
        if (!gp) continue;
        if (gp.suggestedCommitMessage && !commitMessage) {
            commitMessage = gp.suggestedCommitMessage;
        }
        let inBinary = false;
        for (const line of (gp.unidiffPatch ?? '').split('\n')) {
            if (line.startsWith('diff --git ')) {
                const match = line.match(/ b\/(.+)$/);
                const filePath = match
                    ? match[1]
                    : line.replace('diff --git ', '');
                skippingLockfile =
                    !opts?.includeLockfiles && isLockfile(filePath);
                skippingJournal =
                    !opts?.includeJournalFiles && isJournalFile(filePath);
                current = {
                    file: filePath,
                    insertions: 0,
                    deletions: 0,
                };
                if (!skippingLockfile && !skippingJournal) {
                    files.push(current);
                }
                inBinary = false;
                continue;
            }
            if (skippingLockfile || skippingJournal) continue;
            if (line.startsWith('GIT binary patch')) {
                inBinary = true;
                continue;
            }
            if (inBinary) {
                if (line.trim() === '') inBinary = false;
                continue;
            }
            // Skip file headers so they aren't counted as content lines.
            if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
            if (line.startsWith('+')) {
                if (current) current.insertions++;
                insertions++;
            } else if (line.startsWith('-')) {
                if (current) current.deletions++;
                deletions++;
            }
        }
    }

    return {
        hasChanges: files.length > 0,
        changedFiles: files.length,
        insertions,
        deletions,
        files,
        commitMessage,
    };
}

/** One-line trailing annotation describing a session's changeset. */
export function changeSummaryLine(change: ChangeSummary): string {
    if (!change.hasChanges) return 'Changes: none (plan only)';
    const files = `${change.changedFiles} file${change.changedFiles === 1 ? '' : 's'}`;
    return `Changes: ${files}, +${change.insertions}/-${change.deletions}`;
}

/**
 * Compact one-line summary of a session for browsing long lists: state, id,
 * source (with the `sources/github/` prefix trimmed), and title. An optional
 * change summary appends a file count. Designed to stay greppable.
 */
export function formatSessionCompact(
    session: Session,
    change?: ChangeSummary,
): string {
    const source = session.sourceContext.source.replace(
        /^sources\/github\//,
        '',
    );
    const title = session.title ?? session.id;
    const archived = session.archived ? ' [archived]' : '';
    let line = `${session.state}${archived}  ${session.id}  ${source}  ::  ${title}`;
    if (change) {
        line += change.hasChanges
            ? `  (${change.changedFiles} file${change.changedFiles === 1 ? '' : 's'})`
            : '  (no changes)';
    }
    return line;
}

export function formatSession(
    session: Session,
    opts?: { includePrompt?: boolean },
): string {
    const parts: string[] = [];

    parts.push(`Session: ${session.title ?? session.id}`);
    parts.push(`ID: ${session.id}`);
    const state = session.state ?? 'STATE_UNSPECIFIED';
    parts.push(`State: ${state} — ${describeState(state)}`);
    if (session.archived) parts.push('Archived: true');
    if (opts?.includePrompt !== false) {
        parts.push(`Prompt: ${session.prompt}`);
    }
    parts.push(`Source: ${session.sourceContext.source}`);
    parts.push(`URL: ${session.url}`);
    parts.push(`Created: ${session.createTime ?? '(pending)'}`);
    parts.push(`Updated: ${session.updateTime ?? '(pending)'}`);

    if (session.outputs?.length) {
        for (const output of session.outputs) {
            if (output.pullRequest) {
                const pr = output.pullRequest;
                parts.push('');
                parts.push(`Pull Request: ${pr.title}`);
                parts.push(`  URL: ${pr.url}`);
                parts.push(`  ${pr.description}`);
            }
        }
    }

    return parts.join('\n');
}

function formatArtifacts(artifacts: Artifact[]): string {
    const parts: string[] = [];
    for (const artifact of artifacts) {
        if (artifact.changeSet) {
            const cs = artifact.changeSet;
            parts.push(`Change in ${cs.source}:`);
            if (cs.gitPatch) {
                parts.push(
                    `  Commit message: ${cs.gitPatch.suggestedCommitMessage}`,
                );
                parts.push(`  Base: ${cs.gitPatch.baseCommitId}`);
                parts.push(
                    `  Diff:\n${truncatePatch(cs.gitPatch.unidiffPatch)}`,
                );
            }
        }
        if (artifact.bashOutput) {
            const bo = artifact.bashOutput;
            parts.push(`Command: ${bo.command} (exit ${bo.exitCode})`);
            parts.push(`Output:\n${bo.output}`);
        }
        if (artifact.media) {
            parts.push(
                `Media: ${artifact.media.mimeType} (${artifact.media.data.length} bytes base64)`,
            );
        }
    }
    return parts.join('\n');
}

export function formatActivity(activity: Activity): string {
    const parts: string[] = [];
    const time = activity.createTime;

    // Union members are top-level fields on the activity (protobuf oneof
    // flattened in JSON). Exactly one is present.
    if (activity.agentMessaged) {
        parts.push(`[${time}] Agent: ${activity.agentMessaged.agentMessage}`);
    } else if (activity.userMessaged) {
        parts.push(`[${time}] User: ${activity.userMessaged.userMessage}`);
    } else if (activity.planGenerated) {
        parts.push(`[${time}] Plan generated:`);
        parts.push(formatPlan(activity.planGenerated.plan));
    } else if (activity.planApproved) {
        parts.push(`[${time}] Plan approved (${activity.planApproved.planId})`);
    } else if (activity.progressUpdated) {
        parts.push(
            `[${time}] Progress: ${activity.progressUpdated.title} — ${activity.progressUpdated.description}`,
        );
    } else if (activity.sessionCompleted) {
        parts.push(`[${time}] Session completed`);
    } else if (activity.sessionFailed) {
        parts.push(
            `[${time}] Session failed: ${activity.sessionFailed.reason}`,
        );
    } else {
        parts.push(`[${time}] ${activity.description || 'Activity'}`);
    }

    // The API's top-level `description` field can carry extra context even
    // when a union member is present. Append it when it adds information
    // beyond what the union member already provided.
    if (
        activity.description &&
        !activity.agentMessaged &&
        !activity.userMessaged
    ) {
        parts.push(`  Note: ${activity.description}`);
    }

    if (activity.artifacts?.length) {
        parts.push(formatArtifacts(activity.artifacts));
    }

    return parts.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Branch name helpers (#47587)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strip trailing numeric session IDs from Jules branch names.
 * "fix-unsafe-redirect-forgot-password-9689301077527532144" → "fix-unsafe-redirect-forgot-password"
 * Leaves names without a trailing ID unchanged.
 */
export function stripSessionId(branchName: string): string {
    return branchName.replace(/-\d{10,}$/, '');
}

/**
 * Derive a clean, slug-style branch name from a session's title — free of
 * session IDs or other Jules-specific artifacts.
 */
export function suggestBranchName(session: Session): string {
    const title = session.title ?? session.id;
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug || `session-${session.id}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Test-framework conflict detection (#47589)
// ────────────────────────────────────────────────────────────────────────────

/** Known test framework package names for conflict detection. */
const TEST_FRAMEWORKS = [
    'jest',
    'vitest',
    'mocha',
    'jasmine',
    'ava',
    'tap',
    'uvu',
    'ts-jest',
    '@types/jest',
    '@jest/globals',
    '@vitest/coverage-v8',
    '@vitest/ui',
] as const;

/** Mutually exclusive test framework families. */
const FRAMEWORK_FAMILIES: Record<string, string> = {
    jest: 'jest',
    'ts-jest': 'jest',
    '@types/jest': 'jest',
    '@jest/globals': 'jest',
    vitest: 'vitest',
    '@vitest/coverage-v8': 'vitest',
    '@vitest/ui': 'vitest',
    mocha: 'mocha',
    jasmine: 'jasmine',
    ava: 'ava',
    tap: 'tap',
    uvu: 'uvu',
};

export interface DiffWarning {
    type: string;
    message: string;
}

/**
 * Scan a unified diff for potential test framework conflicts in package.json.
 * Looks for added (+) lines containing test framework deps and checks if
 * the existing (-/context) lines contain a different framework family.
 */
export function detectTestFrameworkConflicts(diff: string): DiffWarning[] {
    const warnings: DiffWarning[] = [];
    const pkgPattern = /diff --git a\/[^\s]*package\.json/;
    const lines = diff.split('\n');
    let inPkgJson = false;
    const addedDeps = new Set<string>();
    const existingDeps = new Set<string>();

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            inPkgJson = pkgPattern.test(line);
            continue;
        }
        if (!inPkgJson) continue;

        for (const fw of TEST_FRAMEWORKS) {
            const quoted = `"${fw}"`;
            if (
                line.startsWith('+') &&
                !line.startsWith('+++') &&
                line.includes(quoted)
            ) {
                addedDeps.add(fw);
            }
            if (
                (line.startsWith('-') &&
                    !line.startsWith('---') &&
                    line.includes(quoted)) ||
                (line.startsWith(' ') && line.includes(quoted))
            ) {
                existingDeps.add(fw);
            }
        }
    }

    const addedFamilies = new Set(
        [...addedDeps].map((d) => FRAMEWORK_FAMILIES[d]).filter(Boolean),
    );
    const existingFamilies = new Set(
        [...existingDeps].map((d) => FRAMEWORK_FAMILIES[d]).filter(Boolean),
    );

    for (const addedFamily of addedFamilies) {
        for (const existingFamily of existingFamilies) {
            if (addedFamily !== existingFamily) {
                const addedPkgs = [...addedDeps].filter(
                    (d) => FRAMEWORK_FAMILIES[d] === addedFamily,
                );
                const existingPkgs = [...existingDeps].filter(
                    (d) => FRAMEWORK_FAMILIES[d] === existingFamily,
                );
                warnings.push({
                    type: 'test_framework_conflict',
                    message: `Diff adds ${addedFamily} (${addedPkgs.join(', ')}) but repo already uses ${existingFamily} (${existingPkgs.join(', ')})`,
                });
            }
        }
    }

    return warnings;
}

// ────────────────────────────────────────────────────────────────────────────
// Quality signals (#47590)
// ────────────────────────────────────────────────────────────────────────────

export interface QualitySignal {
    type: string;
    excerpt: string;
}

const REGRESSION_PATTERNS = [
    /\b(?:degradation|regression|slower|worse|performance (?:loss|decrease|drop))\b/i,
    /\bcaused?\s+(?:a\s+)?(?:measurable|noticeable|significant)\s+(?:performance\s+)?(?:degradation|regression)\b/i,
];

const DOUBT_PATTERNS = [
    /\b(?:however|unfortunately),?\s+(?:the\s+change|this|it)\s+(?:was|is|caused?|did)\b/i,
    /\bexplicitly\s+requested\b/i,
    /\bthe\s+ticket\s+said\s+to\b/i,
];

/**
 * Extract quality signals from commit messages, PR descriptions, and plan text.
 * These help reviewers prioritize which diffs need closer scrutiny.
 */
export function extractQualitySignals(texts: string[]): QualitySignal[] {
    const signals: QualitySignal[] = [];
    const combined = texts.join('\n');

    for (const pattern of REGRESSION_PATTERNS) {
        const match = combined.match(pattern);
        if (match) {
            const idx = match.index!;
            const start = combined.lastIndexOf('.', idx);
            const end = combined.indexOf('.', idx + match[0].length);
            const excerpt = combined
                .slice(
                    start >= 0 ? start + 1 : Math.max(0, idx - 80),
                    end >= 0
                        ? end + 1
                        : Math.min(combined.length, idx + match[0].length + 80),
                )
                .trim();
            signals.push({ type: 'self_acknowledged_regression', excerpt });
            break; // one per pattern family
        }
    }

    for (const pattern of DOUBT_PATTERNS) {
        const match = combined.match(pattern);
        if (match) {
            const idx = match.index!;
            const start = combined.lastIndexOf('.', idx);
            const end = combined.indexOf('.', idx + match[0].length);
            const excerpt = combined
                .slice(
                    start >= 0 ? start + 1 : Math.max(0, idx - 80),
                    end >= 0
                        ? end + 1
                        : Math.min(combined.length, idx + match[0].length + 80),
                )
                .trim();
            signals.push({ type: 'implementation_doubt', excerpt });
            break;
        }
    }

    // Check for audit/log redaction
    if (
        /\bredact(?:ed|ing|ion)?\b/i.test(combined) &&
        /\b(?:audit|log(?:ging)?)\b/i.test(combined)
    ) {
        signals.push({
            type: 'audit_data_redaction',
            excerpt:
                'Session redacts data in audit/logging context — verify this is intentional',
        });
    }

    return signals;
}

// ────────────────────────────────────────────────────────────────────────────
// Duplicate session detection (#47588)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a session title for duplicate comparison: lowercase, strip emoji,
 * strip common prefixes like test/fix/chore, collapse whitespace.
 */
export function normalizeTitle(title: string): string {
    return title
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, '') // strip emoji
        .toLowerCase()
        .replace(/^(test|fix|chore|feat|refactor|perf|style|docs)[\s:/-]*/i, '')
        .replace(/\b(add|unit|tests?|for|in|of|the|a|an)\b/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function wordOverlap(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/).filter((w) => w.length > 2));
    const wordsB = new Set(b.split(/\s+/).filter((w) => w.length > 2));
    if (wordsA.size === 0 && wordsB.size === 0) return 0;
    const intersection = [...wordsA].filter((w) => wordsB.has(w));
    return intersection.length / Math.max(wordsA.size, wordsB.size);
}

/**
 * Find duplicate session pairs: same source + similar normalized title.
 * Returns a map from session ID to array of duplicate session IDs.
 */
export function detectDuplicates(
    sessions: Session[],
    changeMap?: Map<string, ChangeSummary>,
): Map<string, string[]> {
    const dupes = new Map<string, string[]>();

    for (let i = 0; i < sessions.length; i++) {
        for (let j = i + 1; j < sessions.length; j++) {
            const a = sessions[i];
            const b = sessions[j];
            if (a.sourceContext.source !== b.sourceContext.source) continue;

            const titleA = normalizeTitle(a.title ?? a.id);
            const titleB = normalizeTitle(b.title ?? b.id);

            const similar =
                titleA === titleB ||
                titleA.includes(titleB) ||
                titleB.includes(titleA) ||
                wordOverlap(titleA, titleB) > 0.6;

            // File-path overlap: if both sessions have change data,
            // check whether they modified overlapping files.
            let fileOverlap = false;
            if (changeMap && !similar) {
                const filesA = changeMap.get(a.id)?.files.map((f) => f.file);
                const filesB = changeMap.get(b.id)?.files.map((f) => f.file);
                if (filesA?.length && filesB?.length) {
                    const setA = new Set(filesA);
                    const shared = filesB.filter((f) => setA.has(f));
                    // Flag as duplicate if any non-trivial file overlap exists.
                    // Ignore if the only shared file is a journal/config file.
                    const meaningful = shared.filter(
                        (f) =>
                            !f.startsWith('.jules/') &&
                            !f.startsWith('.Jules/'),
                    );
                    fileOverlap = meaningful.length > 0;
                }
            }

            if (similar || fileOverlap) {
                if (!dupes.has(a.id)) dupes.set(a.id, []);
                if (!dupes.has(b.id)) dupes.set(b.id, []);
                dupes.get(a.id)!.push(b.id);
                dupes.get(b.id)!.push(a.id);
            }
        }
    }

    return dupes;
}

// ────────────────────────────────────────────────────────────────────────────
// Raw diff extraction (shared helper for warning/signal scanners)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract the raw unified diff text and review-relevant prose from the final
 * change activity in a session. Returns the concatenated diff patches and an
 * array of text blobs (commit messages, PR descriptions, plan text) suitable
 * for scanning by quality-signal detectors.
 */
export function extractReviewContext(
    session: Session,
    activities: Activity[],
): { rawDiff: string; proseTexts: string[] } {
    const changeActivities = activities.filter((a) =>
        a.artifacts?.some((art) => art.changeSet?.gitPatch),
    );
    const last = changeActivities[changeActivities.length - 1];

    const diffParts: string[] = [];
    const proseTexts: string[] = [];

    if (last?.artifacts) {
        for (const art of last.artifacts) {
            const gp = art.changeSet?.gitPatch;
            if (!gp) continue;
            if (gp.unidiffPatch) diffParts.push(gp.unidiffPatch);
            if (gp.suggestedCommitMessage)
                proseTexts.push(gp.suggestedCommitMessage);
        }
    }

    // PR description
    const prDesc = session.outputs?.[0]?.pullRequest?.description;
    if (prDesc) proseTexts.push(prDesc);

    // Plan step text
    const planActivity = activities.find((a) => a.planGenerated);
    if (planActivity?.planGenerated) {
        for (const step of planActivity.planGenerated.plan.steps) {
            proseTexts.push(step.title);
            if (step.description) proseTexts.push(step.description);
        }
    }

    return { rawDiff: diffParts.join('\n'), proseTexts };
}

// ────────────────────────────────────────────────────────────────────────────
// Lockfile / binary helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Filenames treated as generated/lockfile artifacts that are excluded from
 * diff output by default — they bloat context without adding review value.
 */
export const LOCKFILE_PATTERNS: ReadonlyArray<string> = [
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'Gemfile.lock',
    'Cargo.lock',
    'poetry.lock',
    'composer.lock',
    'go.sum',
];

function isLockfile(filePath: string): boolean {
    const basename = filePath.split('/').pop() ?? filePath;
    return LOCKFILE_PATTERNS.includes(basename);
}

function isJournalFile(filePath: string): boolean {
    return filePath.startsWith('.jules/') || filePath.startsWith('.Jules/');
}

export interface FilteredDiff {
    filtered: string;
    excluded: string[];
}

/**
 * Strip lockfile/generated-file diffs from a unified diff, replacing each
 * with a one-line summary. Returns the filtered patch and the list of
 * excluded file paths.
 */
export function stripLockfileDiffs(diff: string): FilteredDiff {
    const lines = diff.split('\n');
    const out: string[] = [];
    const excluded: string[] = [];
    let skipping = false;
    let currentFile = '';

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const match = line.match(/ b\/(.+)$/);
            currentFile = match ? match[1] : '';
            if (isLockfile(currentFile)) {
                skipping = true;
                excluded.push(currentFile);
                out.push(`diff --git a/${currentFile} b/${currentFile}`);
                out.push(
                    `  [lockfile ${currentFile} — diff omitted (${LOCKFILE_PATTERNS.length} known patterns filtered)]`,
                );
                continue;
            }
            skipping = false;
            out.push(line);
            continue;
        }
        if (!skipping) {
            out.push(line);
        }
    }

    return { filtered: out.join('\n'), excluded };
}

/**
 * Strip .jules/ journal-file diffs from a unified diff, replacing each
 * with a one-line summary. Returns the filtered patch and the list of
 * excluded file paths.
 */
export function stripJournalDiffs(diff: string): FilteredDiff {
    const lines = diff.split('\n');
    const out: string[] = [];
    const excluded: string[] = [];
    let skipping = false;
    let currentFile = '';

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const match = line.match(/ b\/(.+)$/);
            currentFile = match ? match[1] : '';
            if (isJournalFile(currentFile)) {
                skipping = true;
                excluded.push(currentFile);
                out.push(`diff --git a/${currentFile} b/${currentFile}`);
                out.push(
                    `  [journal file ${currentFile} — diff omitted to avoid merge conflicts]`,
                );
                continue;
            }
            skipping = false;
            out.push(line);
            continue;
        }
        if (skipping) continue;
        out.push(line);
    }

    return { filtered: out.join('\n'), excluded };
}

/**
 * Replace GIT binary patch blobs (e.g. compiled .pyc files) with a one-line
 * summary per file, so a consolidated diff stays readable. Text hunks are
 * preserved verbatim.
 */
export function stripBinaryHunks(diff: string): string {
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

/**
 * Consolidate a session and its activities into a single review-friendly view:
 * the session header, the plan, and the FINAL cumulative changeset (binary
 * blobs stripped). Jules re-reports the cumulative changeset on successive
 * activities, so the last activity carrying changeset artifacts holds the
 * complete final diff — earlier ones are subsets and are skipped to avoid
 * duplication.
 */
/** Maximum character count before `formatSessionDiff` auto-falls back to summary mode. */
export const DIFF_AUTO_SUMMARY_THRESHOLD = 50_000;

export function formatSessionDiff(
    session: Session,
    activities: Activity[],
    opts?: { includeLockfiles?: boolean; includeJournalFiles?: boolean },
): string {
    const parts: string[] = [];
    parts.push(`Session: ${session.title ?? session.id}`);
    parts.push(`State: ${session.state} — ${describeState(session.state)}`);
    parts.push(`Source: ${session.sourceContext.source}`);
    parts.push(`URL: ${session.url}`);

    const planActivity = activities.find((a) => a.planGenerated);
    if (planActivity?.planGenerated) {
        parts.push('');
        parts.push(formatPlan(planActivity.planGenerated.plan));
    }

    const changeActivities = activities.filter((a) =>
        a.artifacts?.some((art) => art.changeSet?.gitPatch),
    );
    const last = changeActivities[changeActivities.length - 1];

    if (last?.artifacts) {
        parts.push('');
        parts.push('Changes:');
        const excludedFiles: string[] = [];
        for (const art of last.artifacts) {
            if (art.changeSet?.gitPatch) {
                const p = art.changeSet.gitPatch;
                if (p.suggestedCommitMessage) {
                    parts.push(`Commit: ${p.suggestedCommitMessage}`);
                }
                let diff = stripBinaryHunks(p.unidiffPatch ?? '');
                if (!opts?.includeLockfiles) {
                    const { filtered, excluded } = stripLockfileDiffs(diff);
                    diff = filtered;
                    excludedFiles.push(...excluded);
                }
                if (!opts?.includeJournalFiles) {
                    const { filtered, excluded } = stripJournalDiffs(diff);
                    diff = filtered;
                    excludedFiles.push(...excluded);
                }
                parts.push(diff);
            }
        }
        if (excludedFiles.length > 0) {
            parts.push('');
            parts.push(
                `Note: ${excludedFiles.length} lockfile diff${excludedFiles.length === 1 ? '' : 's'} omitted: ${excludedFiles.join(', ')}`,
            );
        }
    } else {
        parts.push('');
        parts.push('(No code changes — session produced a plan only.)');
    }

    const result = parts.join('\n');

    // Auto-fallback: if the full diff still exceeds the threshold after
    // lockfile stripping, return the compact summary instead.
    if (result.length > DIFF_AUTO_SUMMARY_THRESHOLD) {
        const summary = summarizeSessionDiff(session, activities);
        return (
            summary +
            `\n\n(Full diff was ${result.length.toLocaleString()} chars — auto-summarized. Use summary=false with include_lockfiles=true to force full output.)`
        );
    }

    return result;
}

/**
 * Extract the final unified diff from a session's activities in a format
 * suitable for `git apply`. Returns the raw patch text, the suggested commit
 * message, and a file summary. Binary blobs are stripped. Returns null if the
 * session produced no code changes.
 */
export interface PullResult {
    patch: string;
    commitMessage?: string;
    files: FileChange[];
    excludedLockfiles?: string[];
    excludedJournalFiles?: string[];
}

export function extractPatch(
    activities: Activity[],
    opts?: { includeLockfiles?: boolean; includeJournalFiles?: boolean },
): PullResult | null {
    const changeActivities = activities.filter((a) =>
        a.artifacts?.some((art) => art.changeSet?.gitPatch),
    );
    const last = changeActivities[changeActivities.length - 1];
    if (!last?.artifacts) return null;

    const patches: string[] = [];
    let commitMessage: string | undefined;
    const excludedFiles: string[] = [];
    const excludedJournalFilesList: string[] = [];

    for (const art of last.artifacts) {
        const gp = art.changeSet?.gitPatch;
        if (!gp?.unidiffPatch) continue;
        if (gp.suggestedCommitMessage && !commitMessage) {
            commitMessage = gp.suggestedCommitMessage;
        }
        let cleaned = stripBinaryHunks(gp.unidiffPatch);
        if (!opts?.includeLockfiles) {
            const { filtered, excluded } = stripLockfileDiffs(cleaned);
            cleaned = filtered;
            excludedFiles.push(...excluded);
        }
        if (!opts?.includeJournalFiles) {
            const { filtered, excluded } = stripJournalDiffs(cleaned);
            cleaned = filtered;
            excludedJournalFilesList.push(...excluded);
        }
        patches.push(cleaned);
    }

    if (patches.length === 0) return null;

    const summary = summarizeChangeset(activities, {
        includeLockfiles: opts?.includeLockfiles,
    });
    // Filter out excluded lockfiles and journal files from the file summary too
    const allExcluded = [...excludedFiles, ...excludedJournalFilesList];
    const files =
        opts?.includeLockfiles && opts?.includeJournalFiles
            ? summary.files
            : summary.files.filter((f) => !allExcluded.includes(f.file));

    return {
        patch: patches.join('\n'),
        commitMessage,
        files,
        excludedLockfiles: excludedFiles.length > 0 ? excludedFiles : undefined,
        excludedJournalFiles:
            excludedJournalFilesList.length > 0
                ? excludedJournalFilesList
                : undefined,
    };
}

/**
 * Compact, review-friendly summary of a session: header, plan size, and a
 * per-file +/- breakdown of the final changeset WITHOUT the raw diff hunks.
 * Use for large changesets or quick triage when the full
 * `formatSessionDiff` output would be too large.
 */
export function summarizeSessionDiff(
    session: Session,
    activities: Activity[],
): string {
    const parts: string[] = [];
    parts.push(`Session: ${session.title ?? session.id}`);
    parts.push(`State: ${session.state} — ${describeState(session.state)}`);
    parts.push(`Source: ${session.sourceContext.source}`);
    parts.push(`URL: ${session.url}`);

    const planActivity = activities.find((a) => a.planGenerated);
    if (planActivity?.planGenerated) {
        const stepCount = planActivity.planGenerated.plan.steps.length;
        parts.push(`Plan: ${stepCount} step${stepCount === 1 ? '' : 's'}`);
    }

    const change = summarizeChangeset(activities, { includeLockfiles: false });
    parts.push('');
    if (!change.hasChanges) {
        parts.push('(No code changes — session produced a plan only.)');
        return parts.join('\n');
    }

    if (change.commitMessage) {
        parts.push(`Commit: ${change.commitMessage.split('\n')[0]}`);
    }
    parts.push(
        `Changes: ${change.changedFiles} file${change.changedFiles === 1 ? '' : 's'}, +${change.insertions}/-${change.deletions}`,
    );
    for (const f of change.files) {
        parts.push(`  ${f.file}  (+${f.insertions}/-${f.deletions})`);
    }

    return parts.join('\n');
}
