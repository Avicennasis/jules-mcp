import type {
    Session,
    Activity,
    Plan,
    SessionState,
    Artifact,
} from './types.js';

/**
 * Rendered in place of `sourceContext.source` when the API response omits it.
 * Some endpoints (`:approvePlan`) do not send `sourceContext` at all (#50828),
 * and printing an explicit placeholder is more honest than printing
 * `undefined` -- or than throwing, which is what the unguarded deref did.
 */
export const UNKNOWN_SOURCE = '(not reported by the API)';

/**
 * Keyed by `string`, not `SessionState`: that union is open (#50647), so a
 * `Record<SessionState, string>` would demand an entry for every string in
 * existence. The `??` in describeState is the real handler for anything absent.
 */
const STATE_DESCRIPTIONS: Record<string, string> = {
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

    // Legacy / in-the-wild names (#50647). Marked so a reader seeing one knows
    // it is an older vocabulary rather than something we invented.
    PENDING: 'Queued — waiting to start (legacy name for QUEUED)',
    RUNNING: 'In progress — Jules is working (legacy name for IN_PROGRESS)',
    AWAITING_USER_INPUT:
        'Awaiting feedback — Jules needs your input to continue (legacy name for AWAITING_USER_FEEDBACK)',
    CANCELLED: 'Cancelled (legacy) — the session was stopped before finishing',
    CANCELED:
        'Cancelled (legacy, single-L spelling) — the session was stopped before finishing',
    COMPLETED_UNKNOWN:
        'Completed, outcome not reported (legacy) — finished, but the API did not say how',
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
    const header = plan.id ? `Plan ${plan.id}:` : 'Plan:';
    // proto3 omits `index` when it is 0 (the default int value), so a missing
    // index means step 0. Coerce to 0 before sorting/numbering. `steps` itself
    // is omitted entirely when the plan is empty (#42).
    const steps = [...(plan.steps ?? [])]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((s) => {
            const heading = `${(s.index ?? 0) + 1}. ${s.title}`;
            // description is omitted by proto3 when empty
            return s.description ? `${heading}\n   ${s.description}` : heading;
        })
        .join('\n');
    return `${header}\n${steps}`;
}

/** An inclusive line range in the post-image of a file. */
export interface HunkRange {
    start: number;
    end: number;
}

/** Per-file insertion/deletion tally parsed from a unified diff. */
export interface FileChange {
    file: string;
    insertions: number;
    deletions: number;
    /**
     * Post-image line ranges touched in this file, from the `@@` headers.
     * Two sessions editing one file in different functions share a path but
     * no range, which is the distinction #34 turned on.
     */
    hunks?: HunkRange[];
}

/** Lightweight summary of a session's final changeset, derived from activities. */
export interface ChangeSummary {
    hasChanges: boolean;
    changedFiles: number;
    insertions: number;
    deletions: number;
    files: FileChange[];
    commitMessage?: string;
    /**
     * The commit this session's diff is expressed against — Jules pins it when
     * the session is created and NEVER rebases it.
     *
     * This is the single most important field for deciding whether a session is
     * safe to leave alone. If the session writes again, it re-applies its diff
     * from THIS commit, so everything merged since is silently reverted. That is
     * not hypothetical: it cost six merged PRs on GrantLoft and a reverted fix on
     * rDNSFix on 2026-08-23 (Redmine #50386).
     *
     * Absent when the API omits `baseCommitId` — proto3 drops empty strings, so
     * treat undefined as "unknown", never as "no base".
     */
    baseCommitId?: string;
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
    let baseCommitId: string | undefined;
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
        if (gp.baseCommitId && !baseCommitId) {
            // First patch artifact wins: Jules repeats the same pinned base on
            // every artifact of the cumulative changeset.
            baseCommitId = gp.baseCommitId;
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
                    hunks: [],
                };
                if (!skippingLockfile && !skippingJournal) {
                    files.push(current);
                }
                inBinary = false;
                continue;
            }
            if (skippingLockfile || skippingJournal) continue;
            // Capture the post-image range of each hunk so callers can tell
            // "same file" from "same region of that file" (#34).
            if (line.startsWith('@@')) {
                const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
                if (m && current) {
                    const start = Number(m[1]);
                    const count = m[2] === undefined ? 1 : Number(m[2]);
                    current.hunks ??= [];
                    current.hunks.push({
                        start,
                        end: start + Math.max(count, 1) - 1,
                    });
                }
                continue;
            }
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
        baseCommitId,
    };
}

/**
 * One-line trailing annotation describing a session's changeset.
 *
 * Includes the pinned base commit when known. That short sha is the whole point
 * of the line for anyone about to touch the session's PR branch: it is the
 * commit the session will re-apply its diff from if it ever writes again, and
 * anything merged after it gets reverted (Redmine #50386).
 */
export function changeSummaryLine(change: ChangeSummary): string {
    const base = change.baseCommitId
        ? `, base ${change.baseCommitId.slice(0, 7)}`
        : '';
    if (!change.hasChanges) return `Changes: none (plan only)${base}`;
    const files = `${change.changedFiles} file${change.changedFiles === 1 ? '' : 's'}`;
    return `Changes: ${files}, +${change.insertions}/-${change.deletions}${base}`;
}

/**
 * Maximum characters of title kept in a compact row. Titles are frequently the
 * entire task prompt, so this is a hard cap rather than a hint.
 */
export const COMPACT_TITLE_MAX_CHARS = 120;

/**
 * Reduce a session title to something that fits on one line.
 *
 * Jules sets `title` to the full task prompt, which for generated tasks is
 * multi-KB markdown — headings, fenced code, the whole agent brief. Rendering
 * that verbatim is what made `compact` useless at the session counts it exists
 * to serve (#32).
 */
function compactTitle(raw: string, fallback: string): string {
    const firstLine = raw
        .split('\n')
        .find((l) => l.trim() !== '')
        ?.trim();
    if (!firstLine) return fallback;
    return firstLine.length > COMPACT_TITLE_MAX_CHARS
        ? firstLine.slice(0, COMPACT_TITLE_MAX_CHARS).trimEnd() + '…'
        : firstLine;
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
    const source = (session.sourceContext?.source ?? UNKNOWN_SOURCE).replace(
        /^sources\/github\//,
        '',
    );
    const title = compactTitle(session.title ?? session.id, session.id);
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
    parts.push(`Source: ${session.sourceContext?.source ?? UNKNOWN_SOURCE}`);
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
                // Each field is omitted by proto3 when empty, so emit each
                // line only when its field is actually present — rendering
                // `undefined`, or splitting an absent patch, are both bugs
                // that reached production here (#42).
                const gp = cs.gitPatch;
                if (gp.suggestedCommitMessage) {
                    parts.push(
                        `  Commit message: ${gp.suggestedCommitMessage}`,
                    );
                }
                if (gp.baseCommitId) {
                    parts.push(`  Base: ${gp.baseCommitId}`);
                }
                if (gp.unidiffPatch) {
                    parts.push(`  Diff:\n${truncatePatch(gp.unidiffPatch)}`);
                }
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
    // proto3 omits empty fields, so every member below can be absent even when
    // its union branch is present. Interpolating one directly puts the literal
    // string "undefined" in front of the user — which is what shipped, most
    // visibly as "Progress: undefined — undefined" (#42). Fall back to the
    // branch's plain label instead of rendering a hole.
    if (activity.agentMessaged) {
        const msg = activity.agentMessaged.agentMessage;
        parts.push(msg ? `[${time}] Agent: ${msg}` : `[${time}] Agent message`);
    } else if (activity.userMessaged) {
        const msg = activity.userMessaged.userMessage;
        parts.push(msg ? `[${time}] User: ${msg}` : `[${time}] User message`);
    } else if (activity.planGenerated) {
        parts.push(`[${time}] Plan generated:`);
        const plan = activity.planGenerated.plan;
        if (plan) parts.push(formatPlan(plan));
    } else if (activity.planApproved) {
        const planId = activity.planApproved.planId;
        parts.push(
            planId
                ? `[${time}] Plan approved (${planId})`
                : `[${time}] Plan approved`,
        );
    } else if (activity.progressUpdated) {
        const { title, description } = activity.progressUpdated;
        const detail = [title, description].filter(Boolean).join(' — ');
        parts.push(
            detail ? `[${time}] Progress: ${detail}` : `[${time}] Progress`,
        );
    } else if (activity.sessionCompleted) {
        parts.push(`[${time}] Session completed`);
    } else if (activity.sessionFailed) {
        const reason = activity.sessionFailed.reason;
        parts.push(
            reason
                ? `[${time}] Session failed: ${reason}`
                : `[${time}] Session failed`,
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
// Comment-only change detection (#37)
// ────────────────────────────────────────────────────────────────────────────

const COMMENT_PREFIXES = ['//', '/*', '*/', '*', '#', '<!--', '-->', '--'];

function isCommentLine(body: string): boolean {
    const t = body.trim();
    if (t === '') return true;
    return COMMENT_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * Scan a unified diff for files whose every added/removed line is a comment.
 *
 * A comment-only change cannot fail a test and cannot break CI, so it is
 * invisible to every automated signal — the only way to catch a bad one is to
 * read the diff. This flags them for review; it is deliberately not a gate.
 */
export function detectCommentOnlyChanges(diff: string): DiffWarning[] {
    const perFile = new Map<string, { changed: number; comments: number }>();
    let file: string | undefined;

    for (const line of diff.split('\n')) {
        const header = /^diff --git a\/(\S+)/.exec(line);
        if (header) {
            file = header[1];
            continue;
        }
        if (!file) continue;
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (!line.startsWith('+') && !line.startsWith('-')) continue;

        const stats = perFile.get(file) ?? { changed: 0, comments: 0 };
        stats.changed += 1;
        if (isCommentLine(line.slice(1))) stats.comments += 1;
        perFile.set(file, stats);
    }

    const flagged = [...perFile.entries()]
        .filter(([, s]) => s.changed > 0 && s.changed === s.comments)
        .map(([f]) => f);

    if (flagged.length === 0) return [];
    return [
        {
            type: 'comment-only',
            message: `Changes to ${flagged.join(', ')} are comments only — no code changed. Verify the comment is not load-bearing documentation before merging.`,
        },
    ];
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
/**
 * How strong the duplicate claim is, strongest first.
 *
 * - `overlapping-hunks` — the two sessions edit the same lines. They really do
 *   collide.
 * - `same-file` — same file, but the diffs are in different regions of it.
 *   Frequently complementary work rather than duplication.
 * - `similar-title` — titles alone. This is what clusters repeated persona
 *   runs that produced no diff at all, so it stays, but it is the weakest
 *   claim available.
 */
export type DuplicateStrength =
    'overlapping-hunks' | 'same-file' | 'similar-title';

export interface DuplicateMatch {
    id: string;
    strength: DuplicateStrength;
}

/** True when two sets of post-image line ranges intersect. */
function hunksIntersect(a: HunkRange[], b: HunkRange[]): boolean {
    return a.some((ra) =>
        b.some((rb) => ra.start <= rb.end && rb.start <= ra.end),
    );
}

/**
 * Flag sessions that may be redundant, annotating HOW strong each claim is.
 *
 * The feature is deliberately not narrowed: it correctly clusters large runs
 * of repeated persona sessions, which is its main value. What it lacked was
 * precision — two sessions editing different functions of one file were
 * reported identically to two sessions editing the same lines, so acting on
 * the flag without reading both diffs could close legitimate work (#34).
 * Callers now get the strength alongside the id and can decide accordingly.
 */
export function detectDuplicates(
    sessions: Session[],
    changeMap?: Map<string, ChangeSummary>,
): Map<string, DuplicateMatch[]> {
    const dupes = new Map<string, DuplicateMatch[]>();

    const record = (from: string, to: string, strength: DuplicateStrength) => {
        if (!dupes.has(from)) dupes.set(from, []);
        dupes.get(from)!.push({ id: to, strength });
    };

    for (let i = 0; i < sessions.length; i++) {
        for (let j = i + 1; j < sessions.length; j++) {
            const a = sessions[i];
            const b = sessions[j];
            // A session whose source the API did not report is never
            // treated as a duplicate of anything -- two unknowns are not a
            // match (#50828).
            const sourceA = a.sourceContext?.source;
            if (!sourceA || sourceA !== b.sourceContext?.source) continue;

            const titleA = normalizeTitle(a.title ?? a.id);
            const titleB = normalizeTitle(b.title ?? b.id);

            const similar =
                titleA === titleB ||
                titleA.includes(titleB) ||
                titleB.includes(titleA) ||
                wordOverlap(titleA, titleB) > 0.6;

            // Which files do they share, and do the edits actually collide?
            const sharedFiles: string[] = [];
            let collides = false;
            if (changeMap) {
                const changesA = changeMap.get(a.id)?.files;
                const changesB = changeMap.get(b.id)?.files;
                if (changesA?.length && changesB?.length) {
                    const byPathB = new Map(changesB.map((f) => [f.file, f]));
                    for (const fa of changesA) {
                        // A shared .jules/ journal file is bookkeeping, not
                        // evidence that two sessions did the same work.
                        if (
                            fa.file.startsWith('.jules/') ||
                            fa.file.startsWith('.Jules/')
                        ) {
                            continue;
                        }
                        const fb = byPathB.get(fa.file);
                        if (!fb) continue;
                        sharedFiles.push(fa.file);
                        if (
                            fa.hunks?.length &&
                            fb.hunks?.length &&
                            hunksIntersect(fa.hunks, fb.hunks)
                        ) {
                            collides = true;
                        }
                    }
                }
            }

            let strength: DuplicateStrength | undefined;
            if (sharedFiles.length) {
                // Hunk ranges are only decisive when we have them for both
                // sides; without them, a shared path is all we can claim.
                strength = collides ? 'overlapping-hunks' : 'same-file';
            } else if (similar) {
                strength = 'similar-title';
            }

            if (strength) {
                record(a.id, b.id, strength);
                record(b.id, a.id, strength);
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
        for (const step of planActivity.planGenerated.plan?.steps ?? []) {
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

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const match = line.match(/ b\/(.+)$/);
            const currentFile = match ? match[1] : '';
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

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const match = line.match(/ b\/(.+)$/);
            const currentFile = match ? match[1] : '';
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
    parts.push(`Source: ${session.sourceContext?.source ?? UNKNOWN_SOURCE}`);
    parts.push(`URL: ${session.url}`);

    const planActivity = activities.find((a) => a.planGenerated);
    if (planActivity?.planGenerated) {
        parts.push('');
        const plan = planActivity.planGenerated.plan;
        if (plan) parts.push(formatPlan(plan));
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
    parts.push(`Source: ${session.sourceContext?.source ?? UNKNOWN_SOURCE}`);
    parts.push(`URL: ${session.url}`);

    const planActivity = activities.find((a) => a.planGenerated);
    if (planActivity?.planGenerated) {
        const stepCount = planActivity.planGenerated.plan?.steps?.length ?? 0;
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
