# Roadmap — Jules automation

Ideas for putting the Jules session allowance to work without a human in the
loop. Brainstormed 2026-10-23. The lane chosen first was reviving the ZAI→Jules
codegen pipeline (design:
`claude-plans/ServerOps/specs/2026-07-14-zai-jules-codegen-pipeline-design.md`,
Part 1 plan: `claude-plans/ServerOps/plans/2026-07-15-zai-jules-codegen-pipeline-part1-foundation.md`).
Everything below is deferred until that pipeline is live, unless marked otherwise.

Facts the ideas rest on (measured 2026-10-23):

- About 3 sessions/day are consumed today, all by Google-side web-UI schedules
  (Sentinel/Palette personas on GrantLoft and proxyperson). Most end in
  `AWAITING_USER_FEEDBACK` with no PR. Our own server has zero schedules.
- At least 1,000 repos are connected as sources (list capped at 1,000): 849
  TypoScan3000 forks, 117 Avicennasis, 20 Baldwin-Fire-Rescue, 7 Simmons-Systems,
  5 Avic-AI.
- The daily session ceiling has never been measured (#50428). Treat 100/day as a
  claim and cap conservatively.

## Constraints every lane inherits

- Scheduling comes from n8n or a systemd timer, never `jules_schedule_task`
  (in-process node-cron; fires only while a client is connected).
- A conservative daily cap plus a stale-session sweeper, or the Sentinel pile-up
  (#50862) recurs at scale.
- Untrusted text (CI logs, release notes, third-party issues) is nonce-fenced
  before it enters a prompt. Jules fetches URLs it sees, so the fence closes the
  first hop only.
- `JULES_ALLOWED_REPOS` is set on any server instance that automation drives.
- No `AUTO_CREATE_PR` on a prompt built from attacker-writable text.
- A session never rebases: `baseCommitId` is pinned at creation and a later
  write re-applies the diff from that commit (#50386). Rework on a moved branch
  means a new session, not `send_message`.

## Deferred lanes

### 1. TypoScan3000 → Jules

Verified typo tickets become Jules sessions on the forks already connected as
sources. Small, well-specified, self-contained; could absorb 50+ sessions/day on
its own.

Status: this is the Part 1 vertical slice of the codegen pipeline (the pilot
ticket is a TypoScan3000 ticket). Tracked here for the scale-out beyond the
pilot once Part 1 is live.

### 2. Failing CI → `fix-failing-ci`

A GitHub Actions failure (webhook or poll on `workflow_run`
`conclusion=failure`) becomes a session using the existing `fix-failing-ci`
prompt with the log nonce-fenced. Scope: avic, bfr, simsys repos with CI.

### 3. Conflict rebaser

Nightly: open PRs reporting `CONFLICTING` (Jules's own, Dependabot, Renovate)
get a new session started on the PR branch and asked to rebase onto the target.
Fixes the failure mode that stranded earlier Jules PRs (#49352–#49355).

### 4. osv-scanner → `upgrade-dependency`

osv-scanner-fleet findings become sessions using the existing
`upgrade-dependency` prompt, release notes nonce-fenced. Overlaps with the
pipeline's "dep/vuln bumps" work-queue source; build it as a queue feeder for
the pipeline, not a second runner.

### 5. GitHub issue label trigger

A `jules` label on an issue calls `jules_create_session_from_issue` (exists;
fences title, body, labels and comments). Ticket #47113 asks for this. Needs a
webhook receiver (n8n) and a per-repo trust decision for `allow_auto_create_pr`.

### 6. Nightly test-coverage sweep

Lowest-coverage modules across repos that have a suite get the
`add-tests-for-module` prompt. Self-verifying: the suite must stay green. Needs
a per-repo coverage source first.

### 7. Parallel-N implementations

For one Hard ticket, `jules_run_task` with `parallel: 3` and pick the best diff.
Deliberately spends allowance that would otherwise expire; gate it on remaining
daily budget.

## Housekeeping (prerequisites, not lanes)

- Sweep the ~90 stale `AWAITING_USER_FEEDBACK` sessions (#50862, `stale_only`).
- Decide the fate of the Google-side Sentinel/Palette schedules: give them
  `AUTO_CREATE_PR` so they produce reviewable PRs, or delete them in the web UI.
  They are invisible to every tool here.
- Re-confirm the suggestions config (4/5 slots; local record is 118 days old).
- Related open tickets: #47044 TODO/FIXME scanner → Jules tasks, #47016
  auto-merge policy engine, #47014 DAG task scheduling, #50654 gated
  review-loop orchestrator skill.
