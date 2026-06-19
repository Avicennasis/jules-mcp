# jules-mcp

[![CI](https://github.com/Avicennasis/jules-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/Avicennasis/jules-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pre-commit](https://img.shields.io/badge/pre--commit-enabled-brightgreen?logo=pre-commit)](https://github.com/pre-commit/pre-commit)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

An [MCP](https://modelcontextprotocol.io) server that exposes [Google Jules](https://jules.google) — Google's asynchronous coding agent — as tools an MCP client (Claude Code, Claude Desktop, etc.) can call directly.

Built on the **official** Jules REST API (`v1alpha`). No cookie scraping, no headless-browser automation, no reverse-engineered endpoints — just the documented API with an `X-Goog-Api-Key`.

```
You ──▶ MCP client ──▶ jules-mcp ──▶ https://jules.googleapis.com/v1alpha ──▶ Jules
```

- **13 tools** covering sources, sessions, activities, scheduling, a one-shot "run task", and a consolidated session-diff viewer.
- **In-process scheduling** (cron) with AES-256-GCM-encrypted local persistence — no external scheduler required.
- **Auditable**: every mutation requires a `reason` and can emit an audit record; `dry_run` previews mutations without calling the API.
- **Typed & tested**: TypeScript, 64 unit tests, smoke test against the live API.

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
npm test           # 64 unit tests
```

## Configuration

The server reads two environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `JULES_API_KEY` | **yes** | Your Jules API key. Sent as the `X-Goog-Api-Key` header. The server refuses to start without it. |
| `JULES_ENCRYPTION_KEY` | no | Passphrase used to encrypt persisted schedules (AES-256-GCM). If unset, the server auto-generates a key and stores it at `~/.local/share/jules-mcp/.key` (mode `0600`). |

Keep the API key out of source control. Pull it from your shell environment, a `.env` you don't commit, or your secret manager of choice. A `.env.example` is included.

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

Then ask your assistant things like *"list my Jules sources"*, *"create a Jules task on owner/repo to add tests for X"*, or *"show me the diff Jules produced for session 123"*.

## Tool reference

13 tools. Mutating tools (✎) require a `reason` string for the audit trail; tools marked 🔍 support `dry_run`.

### Sources

| Tool | Description | Key params |
|---|---|---|
| `jules_list_sources` | List connected GitHub repos available to Jules. | — |
| `jules_get_source` | Get details for one source. | `source` |

### Sessions

| Tool | Description | Key params |
|---|---|---|
| `jules_create_session` ✎🔍 | Start a coding task. | `prompt`, `source`, `starting_branch`, `title?`, `require_plan_approval?` (default **true**), `automation_mode?` (`AUTO_CREATE_PR`), `reason`, `dry_run?` |
| `jules_list_sessions` | List sessions (paginated). | `page_size?`, `page_token?` |
| `jules_get_session` | Get one session's state, outputs, PR links. | `session_id` |
| `jules_approve_plan` ✎ | Approve a pending plan. Pre-validates the session is in `AWAITING_PLAN_APPROVAL` (returns a `409`-style error otherwise). | `session_id`, `reason` |
| `jules_send_message` ✎ | Send feedback / a follow-up prompt to a session. | `session_id`, `message`, `reason` |

### Activities

| Tool | Description | Key params |
|---|---|---|
| `jules_list_activities` | List a session's activity log (messages, plans, progress, results). | `session_id`, `page_size?`, `page_token?` |
| `jules_get_activity` | Get one activity with full artifacts (changesets, git patches, bash output). | `session_id`, `activity_id` |

### Scheduling

| Tool | Description | Key params |
|---|---|---|
| `jules_schedule_task` ✎🔍 | Schedule a recurring coding task (cron). Validates the cron expression before persisting. | `cron`, `prompt`, `source`, `starting_branch`, `label`, `require_plan_approval?`, `automation_mode?`, `reason`, `dry_run?` |
| `jules_list_schedules` ✎ | `list` all schedules, or `delete` one. `reason` required for delete. | `action` (`list`\|`delete`), `schedule_id?`, `reason?` |

### Convenience & review

| Tool | Description | Key params |
|---|---|---|
| `jules_run_task` ✎ | One-shot: create → poll until the plan is ready → auto-approve → poll to completion → return the result. Returns early if it needs your input (`AWAITING_USER_FEEDBACK`, or `AWAITING_PLAN_APPROVAL` when `auto_approve=false`). | `prompt`, `source`, `starting_branch`, `title?`, `automation_mode?`, `reason`, `auto_approve?` (default true), `poll_interval_ms?` (5000), `timeout_ms?` (600000) |
| `jules_get_session_diff` | A consolidated, review-friendly view: header + plan + the **final** changeset, with binary blobs (e.g. `.pyc`) summarized instead of dumped. | `session_id` |

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

`jules_get_session_diff` handles this for you — it walks the activities, picks the **last** (cumulative) changeset, strips binary patch blobs, and returns the plan + final diff in one readable block. Use it before approving a plan or opening a PR yourself.

## Scheduling recurring tasks

`jules_schedule_task` registers a cron job inside the running server (via `node-cron`). When it fires, it creates a Jules session with the stored prompt/source/branch and emits an audit record.

Schedules persist to `~/.local/share/jules-mcp/schedules.enc`, **encrypted with AES-256-GCM** (key from `JULES_ENCRYPTION_KEY` or an auto-generated local key). They reload on startup. Because the cron runs in-process, the server must be running for schedules to fire — for always-on scheduling, keep the MCP host alive or wrap it in a service manager.

## Audit logging

Every mutation can emit an audit record describing what happened and *why* (the required `reason`):

- If an `inkwell-emit` binary is on `PATH` (the author's house audit tool), records go there.
- Otherwise they fall back to JSONL at `~/.local/share/jules-mcp/audit.jsonl`.
- Audit failures are **swallowed** — a logging problem never blocks a mutation.
- API keys are never written to audit records.

`dry_run: true` on `jules_create_session` / `jules_schedule_task` returns the exact request that *would* be sent, makes no API call, and writes no audit record.

## Jules API quirks worth knowing

These tripped us up while building against the live API; they're handled internally but are worth knowing if you extend the client:

- **Activity union fields are top-level.** The activity payload (`planGenerated`, `progressUpdated`, `sessionCompleted`, …) is serialized as top-level fields on the Activity object — *not* nested under an `activity` key like the docs' tree implies.
- **proto3 omits defaults.** `PlanStep.index` is absent when `0`; `description` is absent when empty. Don't assume they're present.
- **`sendMessage` uses `prompt`, not `message`.** The request body field is `prompt` (same as session creation). Sending `message` returns `400 Unknown name "message"`.
- **Diffs live in activity artifacts**, not `session.outputs`; cumulative changesets repeat across `progressUpdated` activities, so the last artifact-bearing activity holds the complete diff.
- **There is no session close/archive/delete endpoint** in `v1alpha` — sessions are dismissed from the web UI only.

## Project layout

```
src/
├── index.ts              # entry point: wires tools + scheduler, stdio transport
├── jules-client.ts       # typed HTTP client for the Jules API
├── types.ts              # types matching the Jules wire format
├── errors.ts             # structured error classes
├── formatters.ts         # human-readable output (sessions, activities, diffs)
├── audit.ts              # inkwell-emit wrapper + JSONL fallback
├── scheduler/
│   ├── cron.ts           # node-cron manager
│   └── persistence.ts    # AES-256-GCM encrypted schedule store
└── tools/
    ├── sources.ts        ├── sessions.ts     ├── activities.ts
    ├── scheduling.ts     ├── convenience.ts  └── diff.ts
scripts/
├── smoke-test.ts         # hits the live API (needs JULES_API_KEY)
└── ...                   # review/utility scripts
```

## Development

```bash
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm test             # vitest run (64 tests)
npm run test:watch   # vitest watch
npm run smoke        # live API smoke test (lists sources + recent sessions)
npm start            # run the built server (stdio)
```

Tests mock `fetch` and the filesystem, so the unit suite needs no API key. The smoke test does (`JULES_API_KEY`).

## Error handling

The client maps HTTP failures to typed errors, and tools return a consistent shape — `{ "status": "ERROR", "message": ..., "code": ... }` with `isError: true` — instead of throwing raw:

| Error | When |
|---|---|
| `JulesAuthError` | `401` / `403` — bad, expired, or disabled key |
| `JulesNotFoundError` | `404` — unknown session/source (echoes the id) |
| `JulesRateLimitError` | `429` — includes `retry-after` when present |
| `JulesStateError` | invalid state transition (e.g. approving a plan that isn't pending) |
| `JulesAPIError` | any other non-2xx |

Requests also carry a 30s timeout via `AbortSignal.timeout`.

## Roadmap

- Remote streamable-HTTP deployment (Cloudflare Workers or similar)
- Bulk session creation from a task list
- npm publish
- Source auto-selection when only one is connected

## License

MIT — see [LICENSE](LICENSE).
