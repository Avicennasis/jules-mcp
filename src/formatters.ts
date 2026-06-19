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
export function summarizeChangeset(activities: Activity[]): ChangeSummary {
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
                current = {
                    file: match ? match[1] : line.replace('diff --git ', ''),
                    insertions: 0,
                    deletions: 0,
                };
                files.push(current);
                inBinary = false;
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
    let line = `${session.state}  ${session.id}  ${source}  ::  ${title}`;
    if (change) {
        line += change.hasChanges
            ? `  (${change.changedFiles} file${change.changedFiles === 1 ? '' : 's'})`
            : '  (no changes)';
    }
    return line;
}

export function formatSession(session: Session): string {
    const parts: string[] = [];

    parts.push(`Session: ${session.title ?? session.id}`);
    parts.push(`ID: ${session.id}`);
    parts.push(`State: ${session.state} — ${describeState(session.state)}`);
    parts.push(`Prompt: ${session.prompt}`);
    parts.push(`Source: ${session.sourceContext.source}`);
    parts.push(`URL: ${session.url}`);
    parts.push(`Created: ${session.createTime}`);
    parts.push(`Updated: ${session.updateTime}`);

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

    if (activity.artifacts?.length) {
        parts.push(formatArtifacts(activity.artifacts));
    }

    return parts.join('\n');
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
export function formatSessionDiff(
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
        for (const art of last.artifacts) {
            if (art.changeSet?.gitPatch) {
                const p = art.changeSet.gitPatch;
                if (p.suggestedCommitMessage) {
                    parts.push(`Commit: ${p.suggestedCommitMessage}`);
                }
                parts.push(stripBinaryHunks(p.unidiffPatch ?? ''));
            }
        }
    } else {
        parts.push('');
        parts.push('(No code changes — session produced a plan only.)');
    }

    return parts.join('\n');
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

    const change = summarizeChangeset(activities);
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
