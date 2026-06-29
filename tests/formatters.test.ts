import { describe, it, expect } from 'vitest';
import {
    formatSession,
    formatActivity,
    formatPlan,
    describeState,
    truncatePatch,
    stripBinaryHunks,
    stripLockfileDiffs,
    stripJournalDiffs,
    LOCKFILE_PATTERNS,
    DIFF_AUTO_SUMMARY_THRESHOLD,
    formatSessionDiff,
    summarizeChangeset,
    formatSessionCompact,
    changeSummaryLine,
    summarizeSessionDiff,
    extractPatch,
    detectDuplicates,
} from '../src/formatters.js';
import type { ChangeSummary } from '../src/formatters.js';
import type { Session, Activity, Plan } from '../src/types.js';

describe('describeState', () => {
    it('returns human-readable descriptions', () => {
        expect(describeState('QUEUED')).toBe('Queued — waiting to start');
        expect(describeState('AWAITING_PLAN_APPROVAL')).toContain('plan');
        expect(describeState('COMPLETED')).toContain('Complete');
    });
});

describe('truncatePatch', () => {
    it('returns short patches unchanged', () => {
        const patch = 'line1\nline2\nline3';
        expect(truncatePatch(patch, 50)).toBe(patch);
    });

    it('truncates long patches with a count', () => {
        const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
        const patch = lines.join('\n');
        const result = truncatePatch(patch, 10);
        expect(result).toContain('line 0');
        expect(result).toContain('line 9');
        expect(result).toContain('90 more lines');
        expect(result.split('\n').length).toBeLessThan(15);
    });
});

describe('formatPlan', () => {
    it('formats steps as numbered list', () => {
        const plan: Plan = {
            id: 'plan-1',
            steps: [
                {
                    id: 's1',
                    index: 0,
                    title: 'Analyze code',
                    description: 'Read the files',
                },
                {
                    id: 's2',
                    index: 1,
                    title: 'Write fix',
                    description: 'Apply the patch',
                },
            ],
            createTime: '2026-01-01T00:00:00Z',
        };
        const result = formatPlan(plan);
        expect(result).toContain('1. Analyze code');
        expect(result).toContain('2. Write fix');
        expect(result).toContain('Read the files');
    });

    it('omits the description line when a step has no description', () => {
        const plan: Plan = {
            id: 'plan-3',
            steps: [{ id: 's1', index: 0, title: 'No description step' }],
            createTime: '2026-01-01T00:00:00Z',
        };
        const result = formatPlan(plan);
        expect(result).toContain('1. No description step');
        expect(result).not.toContain('undefined');
    });

    it('treats an omitted index as step 0 (proto3 omits default-value ints)', () => {
        // The real Jules API omits `index` on the first step (index 0).
        const plan: Plan = {
            id: 'plan-2',
            steps: [
                {
                    id: 's1',
                    title: 'First step',
                    description: 'no index field',
                },
                {
                    id: 's2',
                    index: 1,
                    title: 'Second step',
                    description: 'has index',
                },
            ],
            createTime: '2026-01-01T00:00:00Z',
        };
        const result = formatPlan(plan);
        expect(result).toContain('1. First step');
        expect(result).toContain('2. Second step');
        expect(result).not.toContain('NaN');
    });
});

describe('formatSession', () => {
    const baseSession: Session = {
        name: 'sessions/abc',
        id: 'abc',
        prompt: 'fix the bug',
        title: 'Bug Fix',
        sourceContext: { source: 'sources/github/o/r' },
        createTime: '2026-01-01T00:00:00Z',
        updateTime: '2026-01-01T01:00:00Z',
        state: 'COMPLETED',
        url: 'https://jules.google/sessions/abc',
        outputs: [
            {
                pullRequest: {
                    url: 'https://github.com/o/r/pull/1',
                    title: 'Fix bug',
                    description: 'Fixes it',
                },
            },
        ],
    };

    it('includes state description and PR link', () => {
        const result = formatSession(baseSession);
        expect(result).toContain('COMPLETED');
        expect(result).toContain('https://github.com/o/r/pull/1');
        expect(result).toContain('Bug Fix');
    });
});

describe('formatActivity', () => {
    it('formats agent messages', () => {
        const activity: Activity = {
            name: 'sessions/abc/activities/1',
            id: '1',
            createTime: '2026-01-01T00:00:00Z',
            originator: 'agent',
            agentMessaged: { agentMessage: 'I found the bug' },
        };
        const result = formatActivity(activity);
        expect(result).toContain('I found the bug');
        expect(result).toContain('Agent');
    });

    it('formats plan generated activities', () => {
        const activity: Activity = {
            name: 'sessions/abc/activities/2',
            id: '2',
            createTime: '2026-01-01T00:00:00Z',
            originator: 'agent',
            planGenerated: {
                plan: {
                    id: 'p1',
                    steps: [
                        {
                            id: 's1',
                            index: 0,
                            title: 'Step 1',
                            description: 'Do thing',
                        },
                    ],
                    createTime: '2026-01-01T00:00:00Z',
                },
            },
        };
        const result = formatActivity(activity);
        expect(result).toContain('Plan');
        expect(result).toContain('Step 1');
    });

    it('formats a progressUpdated activity that also carries a changeset (real wire shape)', () => {
        const activity: Activity = {
            name: 'sessions/abc/activities/3',
            id: '3',
            createTime: '2026-01-01T00:00:00Z',
            originator: 'agent',
            progressUpdated: {
                title: 'Updated isEditable',
                description: 'Used a while loop',
            },
            artifacts: [
                {
                    changeSet: {
                        source: 'sources/github/o/r',
                        gitPatch: {
                            unidiffPatch:
                                'diff --git a/src/content.js b/src/content.js\n+  hello',
                            baseCommitId: 'abc123',
                            suggestedCommitMessage: 'fix isEditable',
                        },
                    },
                },
            ],
        };
        const result = formatActivity(activity);
        expect(result).toContain('Progress');
        expect(result).toContain('Updated isEditable');
        expect(result).toContain('src/content.js');
    });

    it('falls back to description when no union member is present', () => {
        const activity: Activity = {
            name: 'sessions/abc/activities/4',
            id: '4',
            createTime: '2026-01-01T00:00:00Z',
            originator: 'agent',
            description: 'Something happened',
        };
        expect(formatActivity(activity)).toContain('Something happened');
    });
});

describe('stripBinaryHunks', () => {
    it('keeps text diffs unchanged', () => {
        const diff =
            'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new';
        expect(stripBinaryHunks(diff)).toContain('+new');
        expect(stripBinaryHunks(diff)).toContain('-old');
    });

    it('replaces a GIT binary patch blob with a one-line summary', () => {
        const diff = [
            'diff --git a/foo.pyc b/foo.pyc',
            'new file mode 100644',
            'GIT binary patch',
            'literal 27824',
            'zcmdUYdsG`)nqLV?=q(Tk5D!6tz#tyNJdN=a',
            'zOje%u#(2ATEvG$c^=9@A',
            '',
            'diff --git a/bar.js b/bar.js',
            '--- a/bar.js',
            '+++ b/bar.js',
            '@@ -1 +1 @@',
            '+real change',
        ].join('\n');
        const out = stripBinaryHunks(diff);
        expect(out).not.toContain('zcmdUYdsG');
        expect(out).toContain('binary file');
        expect(out).toContain('foo.pyc');
        expect(out).toContain('+real change');
    });
});

describe('formatSessionDiff', () => {
    const session: Session = {
        name: 'sessions/abc',
        id: 'abc',
        prompt: 'fix isEditable',
        title: 'Untested function isEditable',
        sourceContext: { source: 'sources/github/o/r' },
        createTime: '2026-01-01T00:00:00Z',
        updateTime: '2026-01-01T01:00:00Z',
        state: 'COMPLETED',
        url: 'https://jules.google/sessions/abc',
    };

    it('shows the plan and the final cumulative changeset', () => {
        const activities: Activity[] = [
            {
                name: 's/abc/activities/1',
                id: '1',
                createTime: 't',
                originator: 'agent',
                planGenerated: {
                    plan: {
                        id: 'p',
                        createTime: 't',
                        steps: [
                            { id: 's1', title: 'Do it', description: 'now' },
                        ],
                    },
                },
            },
            {
                name: 's/abc/activities/2',
                id: '2',
                createTime: 't',
                originator: 'agent',
                progressUpdated: { title: 'wip', description: 'partial' },
                artifacts: [
                    {
                        changeSet: {
                            source: 'sources/github/o/r',
                            gitPatch: {
                                unidiffPatch:
                                    'diff --git a/f.js b/f.js\n+partial',
                                baseCommitId: 'b',
                                suggestedCommitMessage: 'wip',
                            },
                        },
                    },
                ],
            },
            {
                name: 's/abc/activities/3',
                id: '3',
                createTime: 't',
                originator: 'agent',
                sessionCompleted: {},
                artifacts: [
                    {
                        changeSet: {
                            source: 'sources/github/o/r',
                            gitPatch: {
                                unidiffPatch:
                                    'diff --git a/f.js b/f.js\n+final change',
                                baseCommitId: 'b',
                                suggestedCommitMessage: 'final commit',
                            },
                        },
                    },
                ],
            },
        ];
        const out = formatSessionDiff(session, activities);
        expect(out).toContain('Untested function isEditable');
        expect(out).toContain('1. Do it');
        expect(out).toContain('+final change');
        expect(out).toContain('final commit');
        // Uses the LAST (cumulative) changeset, not the intermediate one
        expect(out).not.toContain('+partial');
    });

    it('notes when a session produced only a plan (no code)', () => {
        const activities: Activity[] = [
            {
                name: 's/abc/activities/1',
                id: '1',
                createTime: 't',
                originator: 'agent',
                planGenerated: {
                    plan: {
                        id: 'p',
                        createTime: 't',
                        steps: [
                            { id: 's1', title: 'Plan only', description: 'x' },
                        ],
                    },
                },
            },
        ];
        const out = formatSessionDiff(session, activities);
        expect(out).toContain('Plan only');
        expect(out.toLowerCase()).toContain('no code');
    });
});

const multiFilePatch = [
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1,2 +1,3 @@',
    ' context',
    '+added one',
    '+added two',
    '-removed one',
    'diff --git a/b.js b/b.js',
    '--- a/b.js',
    '+++ b/b.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
].join('\n');

function changeActivities(patch: string, commit = 'do the thing'): Activity[] {
    return [
        {
            name: 's/abc/activities/1',
            id: '1',
            createTime: 't',
            originator: 'agent',
            sessionCompleted: {},
            artifacts: [
                {
                    changeSet: {
                        source: 'sources/github/o/r',
                        gitPatch: {
                            unidiffPatch: patch,
                            baseCommitId: 'b',
                            suggestedCommitMessage: commit,
                        },
                    },
                },
            ],
        },
    ];
}

describe('summarizeChangeset', () => {
    it('counts changed files and per-file +/- lines, ignoring headers', () => {
        const cs = summarizeChangeset(changeActivities(multiFilePatch));
        expect(cs.hasChanges).toBe(true);
        expect(cs.changedFiles).toBe(2);
        // a.js: +added one, +added two, -removed one  → +2/-1
        // b.js: +new, -old → +1/-1
        expect(cs.insertions).toBe(3);
        expect(cs.deletions).toBe(2);
        expect(cs.files.find((f) => f.file === 'a.js')).toMatchObject({
            insertions: 2,
            deletions: 1,
        });
        expect(cs.files.find((f) => f.file === 'b.js')).toMatchObject({
            insertions: 1,
            deletions: 1,
        });
        expect(cs.commitMessage).toBe('do the thing');
    });

    it('uses the LAST cumulative changeset, not intermediates', () => {
        const activities: Activity[] = [
            {
                name: 's/1',
                id: '1',
                createTime: 't',
                originator: 'agent',
                artifacts: [
                    {
                        changeSet: {
                            source: 'src',
                            gitPatch: {
                                unidiffPatch:
                                    'diff --git a/x.js b/x.js\n+partial',
                                baseCommitId: 'b',
                                suggestedCommitMessage: 'wip',
                            },
                        },
                    },
                ],
            },
            {
                name: 's/2',
                id: '2',
                createTime: 't',
                originator: 'agent',
                artifacts: [
                    {
                        changeSet: {
                            source: 'src',
                            gitPatch: {
                                unidiffPatch:
                                    'diff --git a/x.js b/x.js\n+final\ndiff --git a/y.js b/y.js\n+more',
                                baseCommitId: 'b',
                                suggestedCommitMessage: 'final',
                            },
                        },
                    },
                ],
            },
        ];
        const cs = summarizeChangeset(activities);
        expect(cs.changedFiles).toBe(2);
        expect(cs.commitMessage).toBe('final');
    });

    it('ignores binary blobs when counting', () => {
        const patch = [
            'diff --git a/foo.pyc b/foo.pyc',
            'GIT binary patch',
            'literal 27824',
            'zcmdUYdsG`)nqLV',
            '',
            'diff --git a/real.js b/real.js',
            '--- a/real.js',
            '+++ b/real.js',
            '@@ -1 +1 @@',
            '+real',
        ].join('\n');
        const cs = summarizeChangeset(changeActivities(patch));
        // both files appear, but the binary blob lines are not counted as +/-
        expect(cs.changedFiles).toBe(2);
        expect(cs.insertions).toBe(1);
        expect(cs.deletions).toBe(0);
    });

    it('reports no changes for a plan-only session', () => {
        const cs = summarizeChangeset([
            {
                name: 's/1',
                id: '1',
                createTime: 't',
                originator: 'agent',
                planGenerated: {
                    plan: { id: 'p', createTime: 't', steps: [] },
                },
            },
        ]);
        expect(cs.hasChanges).toBe(false);
        expect(cs.changedFiles).toBe(0);
    });

    it('excludes lockfiles from counts by default', () => {
        const patchWithLockfile = [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '+real code',
            'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
            '--- /dev/null',
            '+++ b/pnpm-lock.yaml',
            ...Array.from({ length: 100 }, () => '+lockfile line'),
        ].join('\n');
        const cs = summarizeChangeset(changeActivities(patchWithLockfile));
        expect(cs.changedFiles).toBe(1);
        expect(cs.files).toHaveLength(1);
        expect(cs.files[0].file).toBe('src/app.ts');
        expect(cs.insertions).toBe(1);
        // Lockfile lines should NOT be counted
        expect(cs.deletions).toBe(0);
    });

    it('includes lockfiles when opted in', () => {
        const patchWithLockfile = [
            'diff --git a/src/app.ts b/src/app.ts',
            '+real code',
            'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
            '+lockfile line',
        ].join('\n');
        const cs = summarizeChangeset(changeActivities(patchWithLockfile), {
            includeLockfiles: true,
        });
        expect(cs.changedFiles).toBe(2);
        expect(cs.files).toHaveLength(2);
        expect(cs.insertions).toBe(2);
    });
});

describe('changeSummaryLine', () => {
    it('summarizes a changeset', () => {
        const cs = summarizeChangeset(changeActivities(multiFilePatch));
        expect(changeSummaryLine(cs)).toBe('Changes: 2 files, +3/-2');
    });

    it('says plan only when there are no changes', () => {
        expect(
            changeSummaryLine({
                hasChanges: false,
                changedFiles: 0,
                insertions: 0,
                deletions: 0,
                files: [],
            }),
        ).toBe('Changes: none (plan only)');
    });
});

describe('formatSessionCompact', () => {
    const session: Session = {
        name: 'sessions/abc',
        id: 'abc',
        prompt: 'fix it',
        title: 'Fix the thing',
        sourceContext: { source: 'sources/github/o/r' },
        createTime: 't',
        updateTime: 't',
        state: 'COMPLETED',
        url: 'u',
    };

    it('is a single greppable line with state, id, trimmed source, and title', () => {
        const line = formatSessionCompact(session);
        expect(line).toBe('COMPLETED  abc  o/r  ::  Fix the thing');
        expect(line.split('\n')).toHaveLength(1);
    });

    it('falls back to id when there is no title', () => {
        const line = formatSessionCompact({ ...session, title: undefined });
        expect(line).toContain('::  abc');
    });

    it('appends a file count when a change summary is supplied', () => {
        const cs = summarizeChangeset(changeActivities(multiFilePatch));
        expect(formatSessionCompact(session, cs)).toContain('(2 files)');
    });

    it('marks no changes when the summary is empty', () => {
        expect(
            formatSessionCompact(session, {
                hasChanges: false,
                changedFiles: 0,
                insertions: 0,
                deletions: 0,
                files: [],
            }),
        ).toContain('(no changes)');
    });
});

describe('summarizeSessionDiff', () => {
    const session: Session = {
        name: 'sessions/abc',
        id: 'abc',
        prompt: 'fix it',
        title: 'Fix the thing',
        sourceContext: { source: 'sources/github/o/r' },
        createTime: 't',
        updateTime: 't',
        state: 'COMPLETED',
        url: 'u',
    };

    it('lists files with +/- counts but not the raw hunks', () => {
        const out = summarizeSessionDiff(
            session,
            changeActivities(multiFilePatch),
        );
        expect(out).toContain('Changes: 2 files, +3/-2');
        expect(out).toContain('a.js  (+2/-1)');
        expect(out).toContain('b.js  (+1/-1)');
        expect(out).toContain('Commit: do the thing');
        // no raw diff content
        expect(out).not.toContain('@@');
        expect(out).not.toContain('+added one');
    });

    it('notes plan-only sessions', () => {
        const out = summarizeSessionDiff(session, [
            {
                name: 's/1',
                id: '1',
                createTime: 't',
                originator: 'agent',
                planGenerated: {
                    plan: {
                        id: 'p',
                        createTime: 't',
                        steps: [{ id: 's1', title: 'only' }],
                    },
                },
            },
        ]);
        expect(out).toContain('Plan: 1 step');
        expect(out.toLowerCase()).toContain('no code');
    });
});

describe('stripLockfileDiffs', () => {
    it('strips known lockfile diffs and lists excluded files', () => {
        const diff = [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '+real code change',
            'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/pnpm-lock.yaml',
            '+lockVersion: 9.0',
            '+dependencies:',
            '+  react: 19.0.0',
            'diff --git a/src/util.ts b/src/util.ts',
            '+another real change',
        ].join('\n');
        const { filtered, excluded } = stripLockfileDiffs(diff);
        expect(excluded).toEqual(['pnpm-lock.yaml']);
        expect(filtered).toContain('+real code change');
        expect(filtered).toContain('+another real change');
        expect(filtered).not.toContain('+lockVersion');
        expect(filtered).not.toContain('+dependencies');
        expect(filtered).toContain('lockfile pnpm-lock.yaml');
    });

    it('handles package-lock.json in subdirectories', () => {
        const diff = [
            'diff --git a/api/package-lock.json b/api/package-lock.json',
            '--- a/api/package-lock.json',
            '+++ b/api/package-lock.json',
            '+massive lockfile content',
        ].join('\n');
        const { filtered, excluded } = stripLockfileDiffs(diff);
        expect(excluded).toEqual(['api/package-lock.json']);
        expect(filtered).not.toContain('+massive');
    });

    it('passes through non-lockfile diffs unchanged', () => {
        const diff = [
            'diff --git a/src/main.ts b/src/main.ts',
            '+code',
        ].join('\n');
        const { filtered, excluded } = stripLockfileDiffs(diff);
        expect(excluded).toEqual([]);
        expect(filtered).toBe(diff);
    });

    it('recognizes all known lockfile patterns', () => {
        for (const lock of LOCKFILE_PATTERNS) {
            const diff = `diff --git a/${lock} b/${lock}\n+content`;
            const { excluded } = stripLockfileDiffs(diff);
            expect(excluded).toContain(lock);
        }
    });
});

describe('extractPatch lockfile filtering', () => {
    const lockfilePatch = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '+real code',
        'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
        '--- /dev/null',
        '+++ b/pnpm-lock.yaml',
        '+lockfile bulk',
    ].join('\n');

    const activities: Activity[] = [
        {
            name: 's/1',
            id: '1',
            createTime: 't',
            originator: 'agent',
            artifacts: [
                {
                    changeSet: {
                        source: 'sources/github/o/r',
                        gitPatch: {
                            unidiffPatch: lockfilePatch,
                            baseCommitId: 'b',
                            suggestedCommitMessage: 'fix it',
                        },
                    },
                },
            ],
        },
    ];

    it('excludes lockfiles by default', () => {
        const result = extractPatch(activities);
        expect(result).not.toBeNull();
        expect(result!.patch).not.toContain('+lockfile bulk');
        expect(result!.patch).toContain('+real code');
        expect(result!.excludedLockfiles).toEqual(['pnpm-lock.yaml']);
        expect(result!.files.some((f) => f.file === 'pnpm-lock.yaml')).toBe(
            false,
        );
    });

    it('includes lockfiles when opted in', () => {
        const result = extractPatch(activities, { includeLockfiles: true });
        expect(result).not.toBeNull();
        expect(result!.patch).toContain('+lockfile bulk');
        expect(result!.excludedLockfiles).toBeUndefined();
    });
});

describe('formatSessionDiff lockfile filtering', () => {
    const session: Session = {
        name: 'sessions/abc',
        id: 'abc',
        prompt: 'fix it',
        title: 'Fix it',
        sourceContext: { source: 'sources/github/o/r' },
        createTime: 't',
        updateTime: 't',
        state: 'COMPLETED',
        url: 'u',
    };

    const lockfilePatch = [
        'diff --git a/src/app.ts b/src/app.ts',
        '+real code',
        'diff --git a/yarn.lock b/yarn.lock',
        '+huge lockfile',
    ].join('\n');

    const activities: Activity[] = [
        {
            name: 's/abc/activities/1',
            id: '1',
            createTime: 't',
            originator: 'agent',
            artifacts: [
                {
                    changeSet: {
                        source: 'sources/github/o/r',
                        gitPatch: {
                            unidiffPatch: lockfilePatch,
                            baseCommitId: 'b',
                            suggestedCommitMessage: 'commit',
                        },
                    },
                },
            ],
        },
    ];

    it('strips lockfiles by default and adds note', () => {
        const out = formatSessionDiff(session, activities);
        expect(out).toContain('+real code');
        expect(out).not.toContain('+huge lockfile');
        expect(out).toContain('1 lockfile diff omitted');
        expect(out).toContain('yarn.lock');
    });

    it('includes lockfiles when opted in', () => {
        const out = formatSessionDiff(session, activities, {
            includeLockfiles: true,
        });
        expect(out).toContain('+huge lockfile');
        expect(out).not.toContain('omitted');
    });

    it('auto-falls back to summary when diff exceeds threshold', () => {
        const hugePatch =
            'diff --git a/big.ts b/big.ts\n' +
            '+x\n'.repeat(DIFF_AUTO_SUMMARY_THRESHOLD);
        const bigActivities: Activity[] = [
            {
                name: 's/abc/activities/1',
                id: '1',
                createTime: 't',
                originator: 'agent',
                artifacts: [
                    {
                        changeSet: {
                            source: 'sources/github/o/r',
                            gitPatch: {
                                unidiffPatch: hugePatch,
                                baseCommitId: 'b',
                                suggestedCommitMessage: 'big commit',
                            },
                        },
                    },
                ],
            },
        ];
        const out = formatSessionDiff(session, bigActivities);
        expect(out).toContain('auto-summarized');
        expect(out).toContain('big.ts');
        // Should NOT contain the raw diff lines
        expect(out.split('\n').length).toBeLessThan(50);
    });
});

describe('detectDuplicates', () => {
    const baseSession: Session = {
        name: 'sessions/abc',
        id: 'abc',
        prompt: 'fix the bug',
        title: 'Bug Fix',
        sourceContext: { source: 'sources/github/o/r' },
        createTime: '2026-01-01T00:00:00Z',
        updateTime: '2026-01-01T01:00:00Z',
        state: 'COMPLETED',
        url: 'https://jules.google/sessions/abc',
        outputs: [],
    };

    it('flags sessions that modify the same file via changeMap', () => {
        const s1: Session = { ...baseSession, id: 'a1', title: 'Refactor auth' };
        const s2: Session = { ...baseSession, id: 'a2', title: 'Add logging' };
        const changeMap = new Map<string, ChangeSummary>([
            ['a1', { hasChanges: true, changedFiles: 1, insertions: 5, deletions: 2, files: [{ file: 'src/app.ts', insertions: 5, deletions: 2 }] }],
            ['a2', { hasChanges: true, changedFiles: 1, insertions: 3, deletions: 1, files: [{ file: 'src/app.ts', insertions: 3, deletions: 1 }] }],
        ]);
        const dupes = detectDuplicates([s1, s2], changeMap);
        expect(dupes.has('a1')).toBe(true);
        expect(dupes.get('a1')).toContain('a2');
        expect(dupes.get('a2')).toContain('a1');
    });

    it('does not flag sessions modifying different files', () => {
        const s1: Session = { ...baseSession, id: 'b1', title: 'Refactor auth' };
        const s2: Session = { ...baseSession, id: 'b2', title: 'Add logging' };
        const changeMap = new Map<string, ChangeSummary>([
            ['b1', { hasChanges: true, changedFiles: 1, insertions: 5, deletions: 2, files: [{ file: 'src/app.ts', insertions: 5, deletions: 2 }] }],
            ['b2', { hasChanges: true, changedFiles: 1, insertions: 3, deletions: 1, files: [{ file: 'src/utils.ts', insertions: 3, deletions: 1 }] }],
        ]);
        const dupes = detectDuplicates([s1, s2], changeMap);
        expect(dupes.has('b1')).toBe(false);
        expect(dupes.has('b2')).toBe(false);
    });

    it('ignores .jules/ files in overlap', () => {
        const s1: Session = { ...baseSession, id: 'c1', title: 'Task one' };
        const s2: Session = { ...baseSession, id: 'c2', title: 'Task two' };
        const changeMap = new Map<string, ChangeSummary>([
            ['c1', { hasChanges: true, changedFiles: 1, insertions: 1, deletions: 0, files: [{ file: '.jules/sentinel.md', insertions: 1, deletions: 0 }] }],
            ['c2', { hasChanges: true, changedFiles: 1, insertions: 1, deletions: 0, files: [{ file: '.jules/sentinel.md', insertions: 1, deletions: 0 }] }],
        ]);
        const dupes = detectDuplicates([s1, s2], changeMap);
        expect(dupes.has('c1')).toBe(false);
        expect(dupes.has('c2')).toBe(false);
    });

    it('works without changeMap (existing behavior)', () => {
        const s1: Session = { ...baseSession, id: 'd1', title: 'Bug Fix' };
        const s2: Session = { ...baseSession, id: 'd2', title: 'Bug Fix' };
        const dupes = detectDuplicates([s1, s2]);
        expect(dupes.has('d1')).toBe(true);
        expect(dupes.get('d1')).toContain('d2');
        expect(dupes.get('d2')).toContain('d1');
    });
});

describe('stripJournalDiffs', () => {
    it('strips .jules/ journal file diffs and lists excluded files', () => {
        const diff = [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '+real code change',
            'diff --git a/.jules/sentinel.md b/.jules/sentinel.md',
            '--- /dev/null',
            '+++ b/.jules/sentinel.md',
            '+journal content',
            '+more journal lines',
            'diff --git a/src/util.ts b/src/util.ts',
            '+another real change',
        ].join('\n');
        const { filtered, excluded } = stripJournalDiffs(diff);
        expect(excluded).toEqual(['.jules/sentinel.md']);
        expect(filtered).toContain('+real code change');
        expect(filtered).toContain('+another real change');
        expect(filtered).not.toContain('+journal content');
        expect(filtered).not.toContain('+more journal lines');
        expect(filtered).toContain('journal file .jules/sentinel.md');
    });

    it('strips .Jules/ (capital J) journal files', () => {
        const diff = [
            'diff --git a/.Jules/palette.md b/.Jules/palette.md',
            '--- /dev/null',
            '+++ b/.Jules/palette.md',
            '+palette content',
            'diff --git a/src/main.ts b/src/main.ts',
            '+code',
        ].join('\n');
        const { filtered, excluded } = stripJournalDiffs(diff);
        expect(excluded).toEqual(['.Jules/palette.md']);
        expect(filtered).not.toContain('+palette content');
        expect(filtered).toContain('+code');
    });

    it('passes through non-journal diffs unchanged', () => {
        const diff = [
            'diff --git a/src/main.ts b/src/main.ts',
            '+code',
        ].join('\n');
        const { filtered, excluded } = stripJournalDiffs(diff);
        expect(excluded).toEqual([]);
        expect(filtered).toBe(diff);
    });

    it('strips multiple journal files in one diff', () => {
        const diff = [
            'diff --git a/.jules/sentinel.md b/.jules/sentinel.md',
            '+sentinel stuff',
            'diff --git a/.jules/palette.md b/.jules/palette.md',
            '+palette stuff',
            'diff --git a/src/app.ts b/src/app.ts',
            '+real code',
        ].join('\n');
        const { filtered, excluded } = stripJournalDiffs(diff);
        expect(excluded).toEqual(['.jules/sentinel.md', '.jules/palette.md']);
        expect(filtered).toContain('+real code');
        expect(filtered).not.toContain('+sentinel stuff');
        expect(filtered).not.toContain('+palette stuff');
    });
});

describe('summarizeChangeset journal file filtering', () => {
    it('excludes journal files from counts by default', () => {
        const patchWithJournal = [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '+real code',
            'diff --git a/.jules/sentinel.md b/.jules/sentinel.md',
            '--- /dev/null',
            '+++ b/.jules/sentinel.md',
            ...Array.from({ length: 50 }, () => '+journal line'),
        ].join('\n');
        const cs = summarizeChangeset(changeActivities(patchWithJournal));
        expect(cs.changedFiles).toBe(1);
        expect(cs.files).toHaveLength(1);
        expect(cs.files[0].file).toBe('src/app.ts');
        expect(cs.insertions).toBe(1);
        expect(cs.deletions).toBe(0);
    });

    it('includes journal files when opted in', () => {
        const patchWithJournal = [
            'diff --git a/src/app.ts b/src/app.ts',
            '+real code',
            'diff --git a/.jules/sentinel.md b/.jules/sentinel.md',
            '+journal line',
        ].join('\n');
        const cs = summarizeChangeset(changeActivities(patchWithJournal), {
            includeJournalFiles: true,
        });
        expect(cs.changedFiles).toBe(2);
        expect(cs.files).toHaveLength(2);
        expect(cs.insertions).toBe(2);
    });
});

describe('extractPatch journal file filtering', () => {
    const journalPatch = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '+real code',
        'diff --git a/.jules/sentinel.md b/.jules/sentinel.md',
        '--- /dev/null',
        '+++ b/.jules/sentinel.md',
        '+journal bulk',
    ].join('\n');

    const activities: Activity[] = [
        {
            name: 's/1',
            id: '1',
            createTime: 't',
            originator: 'agent',
            artifacts: [
                {
                    changeSet: {
                        source: 'sources/github/o/r',
                        gitPatch: {
                            unidiffPatch: journalPatch,
                            baseCommitId: 'b',
                            suggestedCommitMessage: 'fix it',
                        },
                    },
                },
            ],
        },
    ];

    it('excludes journal files by default', () => {
        const result = extractPatch(activities);
        expect(result).not.toBeNull();
        expect(result!.patch).not.toContain('+journal bulk');
        expect(result!.patch).toContain('+real code');
        expect(result!.excludedJournalFiles).toEqual(['.jules/sentinel.md']);
        expect(result!.files.some((f) => f.file === '.jules/sentinel.md')).toBe(
            false,
        );
    });

    it('includes journal files when opted in', () => {
        const result = extractPatch(activities, { includeJournalFiles: true });
        expect(result).not.toBeNull();
        expect(result!.patch).toContain('+journal bulk');
        expect(result!.excludedJournalFiles).toBeUndefined();
    });
});
