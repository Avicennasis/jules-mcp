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
    detectCommentOnlyChanges,
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

    // #42: proto3 omits fields holding the default value, so a changeSet whose
    // diff is empty comes back with NO `unidiffPatch` key at all. Reading it
    // unguarded threw `TypeError: ...reading 'split'` and 500'd the whole
    // jules_list_activities call. Shape taken from a real API response
    // (session 10022951902196532692), where 8 of 26 activities carried a
    // gitPatch whose only key was `baseCommitId`.
    describe('changeSet artifacts with proto3-omitted fields', () => {
        const activityWithPatchKeys = (gitPatch: Record<string, string>) =>
            ({
                name: 'sessions/abc/activities/5',
                id: '5',
                createTime: '2026-01-01T00:00:00Z',
                originator: 'agent',
                progressUpdated: {
                    title: 'Working',
                    description: 'No diff produced',
                },
                artifacts: [
                    {
                        changeSet: {
                            source: 'sources/github/o/r',
                            gitPatch,
                        },
                    },
                ],
            }) as unknown as Activity;

        it('does not throw when unidiffPatch is absent', () => {
            const activity = activityWithPatchKeys({ baseCommitId: 'abc123' });
            expect(() => formatActivity(activity)).not.toThrow();
        });

        it('omits the Diff block entirely when there is no patch', () => {
            const result = formatActivity(
                activityWithPatchKeys({ baseCommitId: 'abc123' }),
            );
            expect(result).not.toContain('Diff:');
            expect(result).toContain('abc123');
        });

        it('omits the commit message line rather than rendering "undefined"', () => {
            const result = formatActivity(
                activityWithPatchKeys({ baseCommitId: 'abc123' }),
            );
            expect(result).not.toContain('undefined');
            expect(result).not.toContain('Commit message:');
        });

        it('still renders both lines when the fields are present', () => {
            const result = formatActivity(
                activityWithPatchKeys({
                    unidiffPatch: 'diff --git a/x.js b/x.js\n+  hi',
                    baseCommitId: 'abc123',
                    suggestedCommitMessage: 'fix x',
                }),
            );
            expect(result).toContain('Commit message: fix x');
            expect(result).toContain('Diff:');
            expect(result).toContain('x.js');
        });
    });

    // #42, second half: the union MEMBER can be present while every field
    // inside it is omitted. TypeScript cannot catch these — a template literal
    // interpolates `undefined` quite happily — so they are only visible by
    // running real payloads through. `progressUpdated: {}` was the majority
    // case in a real session (15 of 27), rendering
    // "Progress: undefined — undefined".
    describe('union members whose fields are all proto3-omitted', () => {
        const activityWith = (union: Record<string, unknown>) =>
            ({
                name: 'sessions/abc/activities/6',
                id: '6',
                createTime: '2026-01-01T00:00:00Z',
                originator: 'agent',
                ...union,
            }) as unknown as Activity;

        it.each([
            ['progressUpdated', { progressUpdated: {} }],
            ['agentMessaged', { agentMessaged: {} }],
            ['userMessaged', { userMessaged: {} }],
            ['planApproved', { planApproved: {} }],
            ['sessionFailed', { sessionFailed: {} }],
            ['planGenerated', { planGenerated: {} }],
            [
                'planGenerated with an empty plan',
                { planGenerated: { plan: {} } },
            ],
        ])('never renders "undefined" for an empty %s', (_name, union) => {
            const result = formatActivity(activityWith(union));
            expect(result).not.toContain('undefined');
        });

        it('still renders progress detail when the fields are present', () => {
            const result = formatActivity(
                activityWith({
                    progressUpdated: {
                        title: 'Ran tests',
                        description: '3 ok',
                    },
                }),
            );
            expect(result).toContain('Progress: Ran tests — 3 ok');
        });

        it('renders just the title when only the title is present', () => {
            const result = formatActivity(
                activityWith({ progressUpdated: { title: 'Ran tests' } }),
            );
            expect(result).toContain('Progress: Ran tests');
            expect(result).not.toContain('—');
        });
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
    it('summarizes a changeset, including the pinned base', () => {
        const cs = summarizeChangeset(changeActivities(multiFilePatch));
        expect(changeSummaryLine(cs)).toBe('Changes: 2 files, +3/-2, base b');
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

    // The base is the field that tells a caller whether the session is safe to
    // leave attached to a PR branch, so it has to survive into the one-line
    // listing form and not only the full diff view (#50386).
    it('shortens a full-length base sha to 7 characters', () => {
        expect(
            changeSummaryLine({
                hasChanges: true,
                changedFiles: 1,
                insertions: 1,
                deletions: 0,
                files: [],
                baseCommitId: '220ee9f07aab147866561f8d5a6ab9223e0e940c',
            }),
        ).toBe('Changes: 1 file, +1/-0, base 220ee9f');
    });

    it('omits the base when the API did not report one', () => {
        expect(
            changeSummaryLine({
                hasChanges: true,
                changedFiles: 1,
                insertions: 1,
                deletions: 0,
                files: [],
            }),
        ).toBe('Changes: 1 file, +1/-0');
    });

    it('still reports the base on a plan-only session', () => {
        expect(
            changeSummaryLine({
                hasChanges: false,
                changedFiles: 0,
                insertions: 0,
                deletions: 0,
                files: [],
                baseCommitId: 'deadbeefcafe',
            }),
        ).toBe('Changes: none (plan only), base deadbee');
    });
});

describe('summarizeChangeset base commit extraction', () => {
    it('carries the pinned base out of the gitPatch artifact', () => {
        const cs = summarizeChangeset(changeActivities(multiFilePatch));
        expect(cs.baseCommitId).toBe('b');
    });

    it('leaves the base undefined when proto3 omitted it', () => {
        // proto3 drops empty strings, so a gitPatch can arrive with no
        // baseCommitId at all. Undefined must mean "unknown", never "no base".
        const activities: Activity[] = [
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
                                unidiffPatch:
                                    'diff --git a/a.txt b/a.txt\n+hello',
                            },
                        },
                    },
                ],
            } as unknown as Activity,
        ];
        const cs = summarizeChangeset(activities);
        expect(cs.hasChanges).toBe(true);
        expect(cs.baseCommitId).toBeUndefined();
    });

    it('leaves the base undefined when there is no changeset at all', () => {
        expect(summarizeChangeset([]).baseCommitId).toBeUndefined();
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

    // #32: `compact` is the flag you reach for precisely when there are many
    // sessions, and it failed in exactly that case — Jules sets `title` to the
    // entire multi-KB task prompt. Measured against the live API: of 179 real
    // sessions, 18 titles contained newlines and the longest was 8,241 chars,
    // against a median of 46. A fixture with a short title passes whether or
    // not the fix works, so these use the real shapes.
    describe('titles that are really full task prompts', () => {
        const realWorldTitle =
            '# 🧹 Code Health Improvement Task\n\nYou are a code health agent. Your mission is to analyze and fix a code health issue.\n\n## Task Details\n\n**File:** `public_html/components/vault/packet-creator-dialog.tsx:35`\n**Issue:** Function too long\n\n```typescript\nexport function PacketCreatorDialog() {\n```';

        it('collapses a multi-line prompt title to one line', () => {
            const line = formatSessionCompact({
                ...session,
                title: realWorldTitle,
            });
            expect(line.split('\n')).toHaveLength(1);
        });

        it('keeps the first line as the title', () => {
            const line = formatSessionCompact({
                ...session,
                title: realWorldTitle,
            });
            expect(line).toContain('Code Health Improvement Task');
            expect(line).not.toContain('Task Details');
            expect(line).not.toContain('packet-creator-dialog');
        });

        it('caps a very long single-line title', () => {
            const line = formatSessionCompact({
                ...session,
                title: 'x'.repeat(8241),
            });
            expect(line.length).toBeLessThan(300);
            expect(line.split('\n')).toHaveLength(1);
        });

        it('marks a truncated title so the cut is visible', () => {
            const line = formatSessionCompact({
                ...session,
                title: 'y'.repeat(500),
            });
            expect(line).toContain('…');
        });

        it('skips leading blank lines rather than emitting an empty title', () => {
            const line = formatSessionCompact({
                ...session,
                title: '\n\n   \nActual title here\nmore',
            });
            expect(line).toContain('Actual title here');
            expect(line.split('\n')).toHaveLength(1);
        });

        it('leaves a short single-line title exactly as it was', () => {
            expect(formatSessionCompact(session)).toBe(
                'COMPLETED  abc  o/r  ::  Fix the thing',
            );
        });
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
        const diff = ['diff --git a/src/main.ts b/src/main.ts', '+code'].join(
            '\n',
        );
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
        const s1: Session = {
            ...baseSession,
            id: 'a1',
            title: 'Refactor auth',
        };
        const s2: Session = { ...baseSession, id: 'a2', title: 'Add logging' };
        const changeMap = new Map<string, ChangeSummary>([
            [
                'a1',
                {
                    hasChanges: true,
                    changedFiles: 1,
                    insertions: 5,
                    deletions: 2,
                    files: [
                        { file: 'src/app.ts', insertions: 5, deletions: 2 },
                    ],
                },
            ],
            [
                'a2',
                {
                    hasChanges: true,
                    changedFiles: 1,
                    insertions: 3,
                    deletions: 1,
                    files: [
                        { file: 'src/app.ts', insertions: 3, deletions: 1 },
                    ],
                },
            ],
        ]);
        const dupes = detectDuplicates([s1, s2], changeMap);
        expect(dupes.has('a1')).toBe(true);
        expect(dupes.get('a1')?.map((d) => d.id)).toContain('a2');
        expect(dupes.get('a2')?.map((d) => d.id)).toContain('a1');
    });

    it('does not flag sessions modifying different files', () => {
        const s1: Session = {
            ...baseSession,
            id: 'b1',
            title: 'Refactor auth',
        };
        const s2: Session = { ...baseSession, id: 'b2', title: 'Add logging' };
        const changeMap = new Map<string, ChangeSummary>([
            [
                'b1',
                {
                    hasChanges: true,
                    changedFiles: 1,
                    insertions: 5,
                    deletions: 2,
                    files: [
                        { file: 'src/app.ts', insertions: 5, deletions: 2 },
                    ],
                },
            ],
            [
                'b2',
                {
                    hasChanges: true,
                    changedFiles: 1,
                    insertions: 3,
                    deletions: 1,
                    files: [
                        { file: 'src/utils.ts', insertions: 3, deletions: 1 },
                    ],
                },
            ],
        ]);
        const dupes = detectDuplicates([s1, s2], changeMap);
        expect(dupes.has('b1')).toBe(false);
        expect(dupes.has('b2')).toBe(false);
    });

    it('ignores .jules/ files in overlap', () => {
        const s1: Session = { ...baseSession, id: 'c1', title: 'Task one' };
        const s2: Session = { ...baseSession, id: 'c2', title: 'Task two' };
        const changeMap = new Map<string, ChangeSummary>([
            [
                'c1',
                {
                    hasChanges: true,
                    changedFiles: 1,
                    insertions: 1,
                    deletions: 0,
                    files: [
                        {
                            file: '.jules/sentinel.md',
                            insertions: 1,
                            deletions: 0,
                        },
                    ],
                },
            ],
            [
                'c2',
                {
                    hasChanges: true,
                    changedFiles: 1,
                    insertions: 1,
                    deletions: 0,
                    files: [
                        {
                            file: '.jules/sentinel.md',
                            insertions: 1,
                            deletions: 0,
                        },
                    ],
                },
            ],
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
        expect(dupes.get('d1')?.map((d) => d.id)).toContain('d2');
        expect(dupes.get('d2')?.map((d) => d.id)).toContain('d1');
        // Titles alone are the weakest available claim.
        expect(dupes.get('d1')?.[0].strength).toBe('similar-title');
    });

    // #34: the concrete false positive. GrantLoft PRs #316 and #320 both edit
    // public_html/lib/access-state.ts with similar titles, but in different
    // functions — #316 around restoreAccess (line ~366) and #320 around
    // checkAccessForAction (line ~440). They are complementary, and acting on
    // an undifferentiated duplicate flag would have closed legitimate work.
    describe('same file, different regions', () => {
        const FILE = 'public_html/lib/access-state.ts';
        const withHunks = (
            id: string,
            hunks: { start: number; end: number }[],
        ): [string, ChangeSummary] => [
            id,
            {
                hasChanges: true,
                changedFiles: 1,
                insertions: 5,
                deletions: 2,
                files: [{ file: FILE, insertions: 5, deletions: 2, hunks }],
            },
        ];

        const sessionsPair = (t1: string, t2: string) => [
            { ...baseSession, id: 'pr316', title: t1 },
            { ...baseSession, id: 'pr320', title: t2 },
        ];

        it('reports same-file, not overlapping-hunks, for disjoint regions', () => {
            const dupes = detectDuplicates(
                sessionsPair(
                    'Fix access state handling',
                    'Fix access state checking',
                ),
                new Map<string, ChangeSummary>([
                    withHunks('pr316', [{ start: 360, end: 372 }]),
                    withHunks('pr320', [{ start: 434, end: 448 }]),
                ]),
            );
            expect(dupes.get('pr316')?.[0].strength).toBe('same-file');
            expect(dupes.get('pr320')?.[0].strength).toBe('same-file');
        });

        it('reports overlapping-hunks when the edits actually collide', () => {
            const dupes = detectDuplicates(
                sessionsPair(
                    'Fix access state handling',
                    'Fix access state checking',
                ),
                new Map<string, ChangeSummary>([
                    withHunks('pr316', [{ start: 360, end: 372 }]),
                    withHunks('pr320', [{ start: 366, end: 380 }]),
                ]),
            );
            expect(dupes.get('pr316')?.[0].strength).toBe('overlapping-hunks');
        });

        it('still flags the pair — this is precision, not removal', () => {
            // The feature correctly clusters ~40 redundant persona sessions,
            // so a disjoint-region pair must still surface, just labelled.
            const dupes = detectDuplicates(
                sessionsPair(
                    'Fix access state handling',
                    'Fix access state checking',
                ),
                new Map<string, ChangeSummary>([
                    withHunks('pr316', [{ start: 360, end: 372 }]),
                    withHunks('pr320', [{ start: 434, end: 448 }]),
                ]),
            );
            expect(dupes.has('pr316')).toBe(true);
            expect(dupes.has('pr320')).toBe(true);
        });

        it('falls back to same-file when hunk data is unavailable', () => {
            // Without ranges on both sides a shared path is all that can be
            // claimed — it must not be upgraded to a collision.
            const dupes = detectDuplicates(
                sessionsPair('Task A', 'Task B'),
                new Map<string, ChangeSummary>([
                    withHunks('pr316', [{ start: 360, end: 372 }]),
                    [
                        'pr320',
                        {
                            hasChanges: true,
                            changedFiles: 1,
                            insertions: 1,
                            deletions: 0,
                            files: [
                                { file: FILE, insertions: 1, deletions: 0 },
                            ],
                        },
                    ],
                ]),
            );
            expect(dupes.get('pr316')?.[0].strength).toBe('same-file');
        });
    });
});

describe('summarizeChangeset hunk ranges (#34)', () => {
    it('captures post-image line ranges from @@ headers', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -360,10 +366,7 @@ function restoreAccess() {',
            '+  changed',
            '@@ -434,4 +440,6 @@ function checkAccessForAction() {',
            '+  also changed',
        ].join('\n');
        const summary = summarizeChangeset(changeActivities(diff));
        expect(summary.files[0].hunks).toEqual([
            { start: 366, end: 372 },
            { start: 440, end: 445 },
        ]);
    });

    it('treats a hunk header with no count as a single line', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -5 +7 @@',
            '+  one line',
        ].join('\n');
        const summary = summarizeChangeset(changeActivities(diff));
        expect(summary.files[0].hunks).toEqual([{ start: 7, end: 7 }]);
    });

    it('does not count @@ headers as content lines', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,3 @@',
            '+added',
            '-removed',
        ].join('\n');
        const summary = summarizeChangeset(changeActivities(diff));
        expect(summary.insertions).toBe(1);
        expect(summary.deletions).toBe(1);
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
        const diff = ['diff --git a/src/main.ts b/src/main.ts', '+code'].join(
            '\n',
        );
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

describe('detectCommentOnlyChanges', () => {
    // Real diff from Avicennasis/GrantLoft#310, which deleted the rationale for
    // a race-condition mitigation and left only the bare header. Green CI, no
    // code change — invisible to every signal except reading the diff.
    const commentDeletion = `diff --git a/public_html/app/api/grants/route.ts b/public_html/app/api/grants/route.ts
index b18bb97..8dea3b7 100644
--- a/public_html/app/api/grants/route.ts
+++ b/public_html/app/api/grants/route.ts
@@ -130,13 +130,6 @@ export async function POST(request: NextRequest) {
     }

     // RACE CONDITION MITIGATION: Re-check the active grant count after insert.
-    // Two concurrent POSTs can both pass the pre-insert canCreateGrant check
-    // before either insert completes. If we're now OVER the limit (not at-limit —
-    // at-limit is the legitimate last-slot fill), roll back.
-    //
-    // NOTE: We cannot reuse canCreateGrant() here because it uses >= (correct
-    // for pre-insert gating). Post-insert, usage == limit is the expected state
-    // after filling the last slot. Only usage > limit means a race occurred.
     try {
       const postUsage = await getEntitlementUsage(profile.org_id)
`;

    it('flags a diff whose every changed line is a comment', () => {
        const warnings = detectCommentOnlyChanges(commentDeletion);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].type).toBe('comment-only');
        expect(warnings[0].message).toContain(
            'public_html/app/api/grants/route.ts',
        );
    });

    it('does not flag a diff that changes code', () => {
        const codeChange = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
     // keep the retry bounded
-    const retries = 3
+    const retries = 5
`;
        expect(detectCommentOnlyChanges(codeChange)).toEqual([]);
    });

    it('recognises # and block-comment styles, not just //', () => {
        const pyAndBlock = `diff --git a/deploy.py b/deploy.py
--- a/deploy.py
+++ b/deploy.py
@@ -1,2 +1,2 @@
-# fail closed: we cannot verify the token here
+# fail closed
 token = read()
diff --git a/src/lib.ts b/src/lib.ts
--- a/src/lib.ts
+++ b/src/lib.ts
@@ -1,3 +1,3 @@
-/* M2: non-fatal, the update surfaces real DB errors */
+/* M2: non-fatal */
 export const x = 1
`;
        const warnings = detectCommentOnlyChanges(pyAndBlock);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain('deploy.py');
        expect(warnings[0].message).toContain('src/lib.ts');
    });

    it('flags only the comment-only file in a mixed changeset', () => {
        const mixed = `diff --git a/src/only-comments.ts b/src/only-comments.ts
--- a/src/only-comments.ts
+++ b/src/only-comments.ts
@@ -1,2 +1,2 @@
-// old note
+// new note
 const a = 1
diff --git a/src/real-code.ts b/src/real-code.ts
--- a/src/real-code.ts
+++ b/src/real-code.ts
@@ -1,2 +1,2 @@
-const b = 1
+const b = 2
`;
        const warnings = detectCommentOnlyChanges(mixed);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain('src/only-comments.ts');
        expect(warnings[0].message).not.toContain('src/real-code.ts');
    });

    it('returns nothing for an empty diff', () => {
        expect(detectCommentOnlyChanges('')).toEqual([]);
    });
});
