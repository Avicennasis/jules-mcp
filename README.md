# jules-mcp

[![CI](https://github.com/Avicennasis/jules-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/Avicennasis/jules-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pre-commit](https://img.shields.io/badge/pre--commit-enabled-brightgreen?logo=pre-commit)](https://github.com/pre-commit/pre-commit)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

An [MCP](https://modelcontextprotocol.io) server that exposes [Google Jules](https://jules.google) — Google's asynchronous coding agent — as tools an MCP client (Claude Code, Claude Desktop, etc.) can call directly.

Built on the **official** Jules REST API (`v1alpha`) with CLI-inspired features from the [Jules Tools Reference](https://jules.google/docs/cli/reference/). No cookie scraping, no headless-browser automation, no reverse-engineered endpoints — just the documented API with an `X-Goog-Api-Key`.

```
You ──▶ MCP client ──▶ jules-mcp ──▶ https://jules.googleapis.com/v1alpha ──▶ Jules
```

- **19 tools** covering sources, sessions, activities, scheduling, a one-shot "run task" (with parallel mode), a patch extractor, a consolidated diff viewer, and local source configuration.
- **In-process scheduling** (cron) with AES-256-GCM-encrypted local persistence — no external scheduler required.
- **Local source config**: track per-repo metadata the API doesn't expose (e.g. whether "suggestions" is enabled) and annotate API responses with it.
- **Auditable**: every mutation requires a `reason` and can emit an audit record; `dry_run` previews mutations without calling the API.
- **Typed & tested**: TypeScript, 89 unit tests, smoke test against the live API.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Use it with Claude Code](#use-it-with-claude-code)
- [Tool reference](#tool-reference)
- [Working with Jules: the lifecycle](#working-with-jules-the-lifecycle)
- [Reviewing what Jules did](#reviewing-what-jules-did)
- [Scheduling recurring tasks](#scheduling-recurring-tasks)
- [Audit logging](#audit-logging)
- [Jules API quirks worth knowing](#jules-api-quirks-worth-knowing)
- [Project layout](#project-layout)
- [Development](#development)
- [Error handling](#error-handling)
- [Roadmap](#roadmap)
- [License](#license)

---

## Why this exists

Jules runs coding tasks in isolated cloud VMs: you give it a repo + a prompt, it writes a plan, executes it, and proposes a changeset/PR. The [Jules API](https://developers.google.com/jules/api) makes that programmable.

Most community "Jules MCP" projects drive the **web UI** by extracting Google session cookies — fragile, likely against ToS, and broken the moment cookies rotate. `jules-mcp` uses the official API key auth instead, so it's stable and headless-friendly.

## Requirements

- **Node.js ≥ 20** (uses built-in `fetch`)
- A **Jules API key** — generate one at [jules.google/settings](https://jules.google/settings) (max 3 active keys per account)
- At least one **source** (GitHub repo) connected to your Jules account

## Install

```bash
git clone https://github.com/Avicennasis/jules-mcp.git
cd jules-mcp
npm install
npm run build      # compiles TypeScript to dist/
npm test           # 89 unit tests
```

## Configuration

The server reads two environment variables:

| Variable               | Required | Purpose                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JULES_API_KEY`        | **yes**  | Your Jules API key. Sent as the `X-Goog-Api-Key` header. The server refuses to start without it.                                                                                                                                                                                            |
| `JULES_ENCRYPTION_KEY` | no       | Passphrase used to encrypt persisted schedules (AES-256-GCM). If unset, the server auto-generates a key and stores it at `~/.local/share/jules-mcp/.key` (mode `0600`) — plaintext hex on disk, so on multi-user systems set this env var instead (see the security note under Scheduling). |

Keep the API key out of source control. Pull it from your shell environment, a `.env` you don't commit, or your secret manager of choice. A `.env.example` is included.

### Local data

The server stores local data at `~/.local/share/jules-mcp/`:

| File                 | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `schedules.enc`      | Cron schedules (AES-256-GCM encrypted)                                    |
| `.key`               | Auto-generated encryption key (mode `0600`), only if no key is configured |
| `source-config.json` | Per-source metadata (suggestions enabled, notes) — plain JSON             |
| `audit.jsonl`        | Audit log fallback when `inkwell-emit` is not on `PATH`                   |

## Use it with Claude Code

Register it as an MCP server (e.g. in a project's `.claude/settings.json` or your plugin config):

```json
{
    "mcpServers": {
        "jules": {
            "command": "node",
            "args": ["dist/index.js"],
            "cwd": "/absolute/path/to/jules-mcp",
            "env": { "JULES_API_KEY": "${JULES_API_KEY}" }
        }
    }
}
```

Then ask your assistant things like _"list my Jules sources"_, _"create a Jules task on owner/repo to add tests for X"_, or _"show me the diff Jules produced for session 123"_.

## Tool reference

19 tools. Mutating tools (✎) require a `reason` string for the audit trail; tools marked 🔍 support `dry_run`; tools marked 🔥 are destructive/irreversible and require an explicit confirmation flag.

### Sources

| Tool                        | Description                                                                                                          | Key params                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jules_list_sources`        | List connected GitHub repos. Supports auto-pagination and AIP-160 filtering. Annotates with local config if present. | `page_size?`, `page_token?`, `filter?` (AIP-160), `max_pages?` (default 10, max 20), `suggestions_only?` (scans the full list; see below), `include_branches?` (default false) |
| `jules_get_source`          | Get details for one source. Annotates with local config if present.                                                  | `source`                                                                                                                                                                       |
| `jules_configure_source` ✎  | Set local metadata the API doesn't expose (e.g. suggestions enabled). Stored on disk and annotated onto responses.   | `source`, `suggestions_enabled?`, `notes?`                                                                                                                                     |
| `jules_list_source_configs` | List all locally-stored source configurations.                                                                       | —                                                                                                                                                                              |

### Sessions

| Tool                        | Description                                                                                                               | Key params                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jules_create_session` ✎🔍  | Start a coding task.                                                                                                      | `prompt`, `source`, `starting_branch`, `title?`, `require_plan_approval?` (default **true**), `automation_mode?` (`AUTO_CREATE_PR`), `reason`, `dry_run?`                                                                                                                             |
| `jules_list_sessions`       | List sessions. Filter by repo or state, browse compactly, or annotate with change status.                                 | `page_size?`, `page_token?`, `source?` (filter by repo), `state?`, `stale_only?` (awaiting feedback + no changes), `compact?` (one line each), `detect_changes?` (annotate file counts), `detect_duplicates?`, `max_pages?` (scan N pages; defaults to 1, or 10 when `source` is set) |
| `jules_get_session`         | Get one session's state, outputs, PR links.                                                                               | `session_id`                                                                                                                                                                                                                                                                          |
| `jules_approve_plan` ✎      | Approve a pending plan. Pre-validates the session is in `AWAITING_PLAN_APPROVAL` (returns a `409`-style error otherwise). | `session_id`, `reason`                                                                                                                                                                                                                                                                |
| `jules_send_message` ✎      | Send feedback / a follow-up prompt to a session.                                                                          | `session_id`, `message`, `reason`                                                                                                                                                                                                                                                     |
| `jules_archive_session` ✎   | Close out a session and hide it from the active list. Reversible.                                                         | `session_id`, `reason`                                                                                                                                                                                                                                                                |
| `jules_unarchive_session` ✎ | Restore a previously archived session to the active list.                                                                 | `session_id`, `reason`                                                                                                                                                                                                                                                                |
| `jules_delete_session` ✎🔥  | **Permanently** delete a session (irreversible). Guarded by `confirm_destructive`; prefer archiving.                      | `session_id`, `reason`, `confirm_destructive` (default false)                                                                                                                                                                                                                         |

### Activities

| Tool                    | Description                                                                  | Key params                                |
| ----------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- |
| `jules_list_activities` | List a session's activity log (messages, plans, progress, results).          | `session_id`, `page_size?`, `page_token?` |
| `jules_get_activity`    | Get one activity with full artifacts (changesets, git patches, bash output). | `session_id`, `activity_id`               |

### Scheduling

| Tool                      | Description                                                                               | Key params                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `jules_schedule_task` ✎🔍 | Schedule a recurring coding task (cron). Validates the cron expression before persisting. | `cron`, `prompt`, `source`, `starting_branch`, `label`, `require_plan_approval?`, `automation_mode?`, `reason`, `dry_run?` |
| `jules_list_schedules` ✎  | `list` all schedules, or `delete` one. `reason` required for delete.                      | `action` (`list`\|`delete`), `schedule_id?`, `reason?`                                                                     |

### Convenience & review

| Tool                     | Description                                                                                                                                                                                                             | Key params                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jules_run_task` ✎       | One-shot: create → poll → auto-approve → wait → return. Returns early if it needs input. Supports `parallel` (1–10) to fan out N independent sessions with the same prompt, matching the Jules CLI's `--parallel` flag. | `prompt`, `source`, `starting_branch`, `title?`, `automation_mode?`, `reason`, `auto_approve?` (true), `poll_interval_ms?` (5000), `timeout_ms?` (600000), `parallel?` (1, max 10) |
| `jules_get_session_diff` | A consolidated, review-friendly view: header + plan + the **final** changeset, with binary blobs (e.g. `.pyc`) summarized instead of dumped. Pass `summary=true` for just files + `+/-` line counts (no raw hunks).     | `session_id`, `summary?`                                                                                                                                                           |
| `jules_pull_session`     | Extract the final code changeset as a `git apply`-ready unified diff patch. Returns the raw patch, suggested commit message, and a per-file +/- summary. Mirrors the Jules CLI's `remote pull` command.                 | `session_id`                                                                                                                                                                       |

**Input normalization:** `session_id` and `source` accept either a bare id or a full resource name (`sessions/abc`, `sources/github/owner/repo`) — both forms work.

## Working with Jules: the lifecycle

A Jules session moves through these states:

```
QUEUED → PLANNING → AWAITING_PLAN_APPROVAL → IN_PROGRESS → COMPLETED
                  ↘ AWAITING_USER_FEEDBACK ↗        ↘ FAILED / PAUSED
```

A typical manual flow:

1. `jules_create_session` (defaults to requiring plan approval).
2. Poll `jules_get_session` until `AWAITING_PLAN_APPROVAL`.
3. Review the plan via `jules_list_activities` / `jules_get_session_diff`.
4. `jules_approve_plan` (or `jules_send_message` to redirect).
5. Poll until `COMPLETED`; read outputs / the PR.

Or skip the babysitting with **`jules_run_task`**, which does create → approve → wait for you.

## Reviewing what Jules did

> **Heads-up:** `session.outputs` is frequently empty even when Jules made changes. The actual diffs live in **activity artifacts** (`changeSet.gitPatch.unidiffPatch`).

`jules_get_session_diff` handles this for you — it walks the activities, picks the **last** (cumulative) changeset, strips binary patch blobs, and returns the plan + final diff in one readable block. Use it before approving a plan or opening a PR yourself. For a large changeset, pass `summary=true` to get just the list of changed files with `+/-` line counts instead of the full diff.

**Clearing out abandoned sessions.** Sessions that are awaiting feedback but produced no diff pile up — 37 of one repo's 104, nearly all repeated persona runs with no PR and nothing to review. `jules_list_sessions(stale_only: true)` selects exactly those, and `jules_archive_session` clears them:

```
jules_list_sessions(source: "GrantLoft", stale_only: true, compact: true)
```

`stale_only` implies `detect_changes`, narrows by state first so excluded sessions cost no extra API call, and deliberately excludes any session whose activities fetch failed — missing change data is not evidence of no changes.

**Branch lists are omitted by default.** `jules_list_sources` used to return every branch of every repo, which grows without bound as Jules opens task branches: across 474 connected sources that was 5,227 branches and 72.7% of the payload, one repo carrying 515 on its own. Each repo now reports `branchCount` and keeps `defaultBranch`; pass `include_branches: true` when you actually need the lists.

**Duplicate flags carry a strength.** `detect_duplicates` annotates each match with how strong the claim actually is, because "same file" and "same lines" are very different things and used to render identically:

| label               | meaning                                             | how much to trust it                                      |
| ------------------- | --------------------------------------------------- | --------------------------------------------------------- |
| `overlapping-hunks` | the two sessions edit intersecting line ranges      | strong — they really do collide                           |
| `same-file`         | shared file, but the diffs sit in different regions | weak — frequently complementary work                      |
| `similar-title`     | titles alone; no shared file, or no diff at all     | weakest — but this is what clusters repeated persona runs |

Read both diffs before closing anything flagged `same-file` or `similar-title`.

**The suggestions quota is local, not live.** Jules allows its "suggestions" feature on at most 5 repos, but the API does not expose which repos have it enabled — confirmed across all 474 connected sources, where each carries only `name`, `id` and `githubRepo`. `jules_configure_source` records it locally instead, so `suggestionsQuota` reflects what was last written there and can drift from reality if suggestions are toggled in the Jules web UI. Every response that reports the quota therefore names it as local and publishes the age of the oldest record, flagging it stale past 30 days. `suggestions_only` scans the whole source list by default; if a scan is truncated the quota renders as `at least N of 5 … SCAN INCOMPLETE` rather than an exact count, because a truncating filter cannot prove absence.

**Finding the sessions for one repo:** `jules_list_sessions` returns _all_ sessions across every connected repo, which can be a lot. Pass `source` to filter to one repo (it scans up to 10 pages by default to gather matches), `compact: true` for a one-line-per-session listing, and `detect_changes: true` to mark which sessions actually produced code vs. a plan only — e.g. `jules_list_sessions(source: "bfr-shift-dashboard", compact: true, detect_changes: true)`.

## Scheduling recurring tasks

`jules_schedule_task` registers a cron job inside the running server (via `node-cron`). When it fires, it creates a Jules session with the stored prompt/source/branch and emits an audit record.

Schedules persist to `~/.local/share/jules-mcp/schedules.enc`, **encrypted with AES-256-GCM** (key from `JULES_ENCRYPTION_KEY` or an auto-generated local key). They reload on startup. Because the cron runs in-process, the server must be running for schedules to fire — for always-on scheduling, keep the MCP host alive or wrap it in a service manager.

> **Security note — auto-generated key.** When `JULES_ENCRYPTION_KEY` is unset, the auto-generated key is persisted as plaintext hex at `~/.local/share/jules-mcp/.key` (file mode `0600`, directory `0700`, re-tightened on every load). That protects against other unprivileged users, but anyone who can read your home directory — root, backup processes, or a misconfigured share — can decrypt `schedules.enc` with it. On multi-user or shared systems, set `JULES_ENCRYPTION_KEY` from your secret manager instead so the key never touches disk. Schedule entries can contain prompts and repo names; treat them accordingly.

## Audit logging

Every mutation can emit an audit record describing what happened and _why_ (the required `reason`):

- If an `inkwell-emit` binary is on `PATH` (the author's house audit tool), records go there.
- Otherwise they fall back to JSONL at `~/.local/share/jules-mcp/audit.jsonl`.
- Audit failures are **swallowed** — a logging problem never blocks a mutation.
- API keys are never written to audit records.

`dry_run: true` on `jules_create_session` / `jules_schedule_task` returns the exact request that _would_ be sent, makes no API call, and writes no audit record.

## Jules API quirks worth knowing

These tripped us up while building against the live API; they're handled internally but are worth knowing if you extend the client:

- **Activity union fields are top-level.** The activity payload (`planGenerated`, `progressUpdated`, `sessionCompleted`, …) is serialized as top-level fields on the Activity object — _not_ nested under an `activity` key like the docs' tree implies.
- **proto3 omits defaults.** `PlanStep.index` is absent when `0`; `description` is absent when empty. Don't assume they're present.
- **`sendMessage` uses `prompt`, not `message`.** The request body field is `prompt` (same as session creation). Sending `message` returns `400 Unknown name "message"`.
- **Diffs live in activity artifacts**, not `session.outputs`; cumulative changesets repeat across `progressUpdated` activities, so the last artifact-bearing activity holds the complete diff.
- **Sessions can be archived, unarchived, and deleted** via `v1alpha` (`:archive`, `:unarchive`, and `DELETE`). Archiving is reversible and is the recommended way to close out finished work; `Session.archived` reflects the state. (Earlier `v1alpha` had no such endpoints — they were added later, so older notes claiming "web UI only" are out of date.)

## Project layout

```
src/
├── index.ts              # entry point: wires tools + scheduler, stdio transport
├── jules-client.ts       # typed HTTP client for the Jules API
├── types.ts              # types matching the Jules wire format
├── errors.ts             # structured error classes
├── formatters.ts         # human-readable output (sessions, activities, diffs, patches)
├── audit.ts              # inkwell-emit wrapper + JSONL fallback
├── source-config.ts      # local per-source metadata store (suggestions, notes)
├── scheduler/
│   ├── cron.ts           # node-cron manager
│   └── persistence.ts    # AES-256-GCM encrypted schedule store
└── tools/
    ├── sources.ts        # list, get, configure, list-configs
    ├── sessions.ts       # create, list, get, approve, message, archive, delete
    ├── activities.ts     # list, get
    ├── scheduling.ts     # schedule_task, list_schedules
    ├── convenience.ts    # run_task (with parallel mode)
    └── diff.ts           # get_session_diff, pull_session
scripts/
├── smoke-test.ts         # hits the live API (needs JULES_API_KEY)
└── ...                   # review/utility scripts
```

## Development

```bash
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm test             # vitest run (89 tests)
npm run test:watch   # vitest watch
npm run smoke        # live API smoke test (lists sources + recent sessions)
npm start            # run the built server (stdio)
```

Tests mock `fetch` and the filesystem, so the unit suite needs no API key. The smoke test does (`JULES_API_KEY`).

## Error handling

The client maps HTTP failures to typed errors, and tools return a consistent shape — `{ "status": "ERROR", "message": ..., "code": ... }` with `isError: true` — instead of throwing raw:

| Error                 | When                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `JulesAuthError`      | `401` / `403` — bad, expired, or disabled key                       |
| `JulesNotFoundError`  | `404` — unknown session/source (echoes the id)                      |
| `JulesRateLimitError` | `429` — includes `retry-after` when present                         |
| `JulesStateError`     | invalid state transition (e.g. approving a plan that isn't pending) |
| `JulesAPIError`       | any other non-2xx                                                   |

Requests also carry a 30s timeout via `AbortSignal.timeout`.

## Roadmap

- Remote streamable-HTTP deployment (Cloudflare Workers or similar)
- npm publish
- Source auto-selection when only one is connected
- ~~Bulk session creation from a task list~~ — done via `parallel` param on `jules_run_task`

## License

MIT — see [LICENSE](LICENSE).
