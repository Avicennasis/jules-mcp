import { describe, it, expect } from 'vitest';
import {
  formatSession,
  formatActivity,
  formatPlan,
  describeState,
  truncatePatch,
  stripBinaryHunks,
  formatSessionDiff,
  summarizeChangeset,
  formatSessionCompact,
  changeSummaryLine,
  summarizeSessionDiff,
} from '../src/formatters.js';
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
        { id: 's1', index: 0, title: 'Analyze code', description: 'Read the files' },
        { id: 's2', index: 1, title: 'Write fix', description: 'Apply the patch' },
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
        { id: 's1', title: 'First step', description: 'no index field' },
        { id: 's2', index: 1, title: 'Second step', description: 'has index' },
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
    outputs: [{ pullRequest: { url: 'https://github.com/o/r/pull/1', title: 'Fix bug', description: 'Fixes it' } }],
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
          steps: [{ id: 's1', index: 0, title: 'Step 1', description: 'Do thing' }],
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
      progressUpdated: { title: 'Updated isEditable', description: 'Used a while loop' },
      artifacts: [
        {
          changeSet: {
            source: 'sources/github/o/r',
            gitPatch: {
              unidiffPatch: 'diff --git a/src/content.js b/src/content.js\n+  hello',
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
    const diff = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new';
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
        name: 's/abc/activities/1', id: '1', createTime: 't', originator: 'agent',
        planGenerated: { plan: { id: 'p', createTime: 't', steps: [{ id: 's1', title: 'Do it', description: 'now' }] } },
      },
      {
        name: 's/abc/activities/2', id: '2', createTime: 't', originator: 'agent',
        progressUpdated: { title: 'wip', description: 'partial' },
        artifacts: [{ changeSet: { source: 'sources/github/o/r', gitPatch: { unidiffPatch: 'diff --git a/f.js b/f.js\n+partial', baseCommitId: 'b', suggestedCommitMessage: 'wip' } } }],
      },
      {
        name: 's/abc/activities/3', id: '3', createTime: 't', originator: 'agent',
        sessionCompleted: {},
        artifacts: [{ changeSet: { source: 'sources/github/o/r', gitPatch: { unidiffPatch: 'diff --git a/f.js b/f.js\n+final change', baseCommitId: 'b', suggestedCommitMessage: 'final commit' } } }],
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
        name: 's/abc/activities/1', id: '1', createTime: 't', originator: 'agent',
        planGenerated: { plan: { id: 'p', createTime: 't', steps: [{ id: 's1', title: 'Plan only', description: 'x' }] } },
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
      name: 's/abc/activities/1', id: '1', createTime: 't', originator: 'agent',
      sessionCompleted: {},
      artifacts: [{ changeSet: { source: 'sources/github/o/r', gitPatch: { unidiffPatch: patch, baseCommitId: 'b', suggestedCommitMessage: commit } } }],
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
    expect(cs.files.find((f) => f.file === 'a.js')).toMatchObject({ insertions: 2, deletions: 1 });
    expect(cs.files.find((f) => f.file === 'b.js')).toMatchObject({ insertions: 1, deletions: 1 });
    expect(cs.commitMessage).toBe('do the thing');
  });

  it('uses the LAST cumulative changeset, not intermediates', () => {
    const activities: Activity[] = [
      {
        name: 's/1', id: '1', createTime: 't', originator: 'agent',
        artifacts: [{ changeSet: { source: 'src', gitPatch: { unidiffPatch: 'diff --git a/x.js b/x.js\n+partial', baseCommitId: 'b', suggestedCommitMessage: 'wip' } } }],
      },
      {
        name: 's/2', id: '2', createTime: 't', originator: 'agent',
        artifacts: [{ changeSet: { source: 'src', gitPatch: { unidiffPatch: 'diff --git a/x.js b/x.js\n+final\ndiff --git a/y.js b/y.js\n+more', baseCommitId: 'b', suggestedCommitMessage: 'final' } } }],
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
      { name: 's/1', id: '1', createTime: 't', originator: 'agent', planGenerated: { plan: { id: 'p', createTime: 't', steps: [] } } },
    ]);
    expect(cs.hasChanges).toBe(false);
    expect(cs.changedFiles).toBe(0);
  });
});

describe('changeSummaryLine', () => {
  it('summarizes a changeset', () => {
    const cs = summarizeChangeset(changeActivities(multiFilePatch));
    expect(changeSummaryLine(cs)).toBe('Changes: 2 files, +3/-2');
  });

  it('says plan only when there are no changes', () => {
    expect(changeSummaryLine({ hasChanges: false, changedFiles: 0, insertions: 0, deletions: 0, files: [] })).toBe('Changes: none (plan only)');
  });
});

describe('formatSessionCompact', () => {
  const session: Session = {
    name: 'sessions/abc', id: 'abc', prompt: 'fix it', title: 'Fix the thing',
    sourceContext: { source: 'sources/github/o/r' },
    createTime: 't', updateTime: 't', state: 'COMPLETED', url: 'u',
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
    expect(formatSessionCompact(session, { hasChanges: false, changedFiles: 0, insertions: 0, deletions: 0, files: [] })).toContain('(no changes)');
  });
});

describe('summarizeSessionDiff', () => {
  const session: Session = {
    name: 'sessions/abc', id: 'abc', prompt: 'fix it', title: 'Fix the thing',
    sourceContext: { source: 'sources/github/o/r' },
    createTime: 't', updateTime: 't', state: 'COMPLETED', url: 'u',
  };

  it('lists files with +/- counts but not the raw hunks', () => {
    const out = summarizeSessionDiff(session, changeActivities(multiFilePatch));
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
      { name: 's/1', id: '1', createTime: 't', originator: 'agent', planGenerated: { plan: { id: 'p', createTime: 't', steps: [{ id: 's1', title: 'only' }] } } },
    ]);
    expect(out).toContain('Plan: 1 step');
    expect(out.toLowerCase()).toContain('no code');
  });
});
