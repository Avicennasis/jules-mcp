# jules-mcp — Design Sketch

## Overview

MCP server wrapping the Google Jules API (v1alpha), exposing Jules' async coding
agent as tools that Claude Code can call directly. Built on the official API —
no cookie scraping, no browser automation.

Intended for public release — designed to work standalone without requiring
any specific workflow automation platform.

## Deployment Model

**Local stdio**, packaged as a Claude Code plugin MCP server.
Future: remote streamable-HTTP for broader distribution.

- API key from env var `JULES_API_KEY`
- Passed as `X-Goog-Api-Key` header on every request
- No OAuth complexity needed — Jules uses simple API keys (max 3 per account)
- For SimmonsSystems: key lives in SOPS vault (`google.jules.api_key`),
  sourced via `~/.bash_secrets`

## API Surface

Base URL: `https://jules.googleapis.com/v1alpha`

### Resources

**Source** — a connected GitHub repo
**Session** — a coding task (the core unit of work)
**Activity** — a log entry within a session (messages, plans, progress, artifacts)

### Session Lifecycle

```
QUEUED → PLANNING → AWAITING_PLAN_APPROVAL → IN_PROGRESS → COMPLETED
                  ↘ AWAITING_USER_FEEDBACK ↗        ↘ FAILED
                                                      ↘ PAUSED
```

Key states:
- `AWAITING_PLAN_APPROVAL` — Jules has a plan, needs `approve_plan` call
- `AWAITING_USER_FEEDBACK` — Jules is blocked, needs `send_message` call
- `IN_PROGRESS` — Jules is working, poll with `get_session`
- `COMPLETED` — check `outputs[]` for PRs

## MCP Tools (12 total)

### Sources (2 tools)

| Tool | Jules API | Description |
|------|-----------|-------------|
| `jules_list_sources` | `GET /sources` | List connected GitHub repos. Returns name, repo details. |
| `jules_get_source` | `GET /sources/{id}` | Get details for a specific source. |

### Sessions (5 tools)

| Tool | Jules API | Description |
|------|-----------|-------------|
| `jules_create_session` | `POST /sessions` | Create a coding task. Params: `prompt` (required), `source` (required — source name), `starting_branch` (required), `title` (optional), `require_plan_approval` (optional, default **true**), `automation_mode` (optional — `AUTO_CREATE_PR` to auto-PR). |
| `jules_list_sessions` | `GET /sessions` | List sessions with pagination. Params: `page_size` (optional), `page_token` (optional). |
| `jules_get_session` | `GET /sessions/{id}` | Get session status, state, outputs. Use to poll progress or check for PR links. |
| `jules_approve_plan` | `POST /sessions/{id}:approvePlan` | Approve a pending plan. Only valid when state is `AWAITING_PLAN_APPROVAL`. |
| `jules_send_message` | `POST /sessions/{id}:sendMessage` | Send feedback/instructions to Jules. Used when state is `AWAITING_USER_FEEDBACK` or to provide additional context. Params: `message` (required). |

### Activities (2 tools)

| Tool | Jules API | Description |
|------|-----------|-------------|
| `jules_list_activities` | `GET /sessions/{id}/activities` | List activity log for a session. Shows messages, plans, progress updates, completion/failure. Params: `session_id` (required), `page_size` (optional), `page_token` (optional). |
| `jules_get_activity` | `GET /sessions/{id}/activities/{activity_id}` | Get a single activity with full detail — includes artifacts (changesets, git patches, bash output, media). |

### Scheduling (2 tools)

| Tool | Jules API | Description |
|------|-----------|-------------|
| `jules_schedule_task` | N/A (server-side) | Schedule a recurring coding task. Params: `cron` (cron expression), `prompt` (required), `source` (required), `starting_branch` (required), `label` (human-readable name), `require_plan_approval` (optional, default true), `automation_mode` (optional). Schedules are persisted locally with AES-256-GCM encryption. |
| `jules_list_schedules` | N/A (server-side) | List/manage scheduled tasks. Params: `action` (`list` / `delete`), `schedule_id` (for delete). |

### Convenience (1 tool)

| Tool | Jules API | Description |
|------|-----------|-------------|
| `jules_run_task` | composite | Create a session, poll until plan is ready, auto-approve, poll until completion, return results. One-shot "fire and forget" for when you trust Jules to just do the thing. Params: same as `create_session` plus `auto_approve` (default true), `poll_interval_ms` (default 5000), `timeout_ms` (default 600000 / 10 min). Reports progress via MCP progress notifications. |

## Tool Design Notes

### Input conventions
- `session_id` accepts either bare ID or full resource name (`sessions/abc123`)
- `source` accepts either bare name or full resource name (`sources/github/owner/repo`)
- Server normalizes both forms before hitting the API

### Output formatting
- Sessions: return state prominently, with human-readable state descriptions
- Plans: format steps as numbered list with titles and descriptions
- Activities: format by type — quote agent messages, show plan steps, summarize progress
- PRs: surface URL, title, description at top level when present
- Git patches: include but truncate large diffs (show first 50 lines + "N more lines")

### Error handling
Structured error types following the DO/Porkbun MCP pattern:
- `JulesAPIError` — base, with `message`, `statusCode`, `hint` fields
- `JulesAuthError` — 401/403 (expired? disabled? wrong key?)
- `JulesNotFoundError` — 404 (session/source not found, echo the ID used)
- `JulesRateLimitError` — 429 (include retry-after if available)
- `JulesStateError` — state violation (e.g. approve_plan when not AWAITING_PLAN_APPROVAL — explain current state and what's valid)

Tools catch these and return structured JSON `{"status": "ERROR", "message": ..., "code": ...}` — exceptions never propagate raw.

### Mutation parameters
Following the house pattern from DO/Porkbun MCP servers:
- **`reason`** (required string) on all mutation tools: `create_session`, `approve_plan`,
  `send_message`, `schedule_task`. Flows into audit logging.
- **`dry_run`** (optional boolean, default false) on `create_session` and `schedule_task`.
  When true, returns `{"status": "DRY_RUN", "would_request": {...}}` — no API call, no audit row.

## Audit & Observability

### Inkwell changelog logging
All mutations emit to `/opt/inkwell/changes.db` via `inkwell-emit`, following the
same pattern as the DO and Porkbun MCP servers:

```
inkwell-emit \
  --source "jules-mcp" \
  --category "coding-task" \          # or "scheduling"
  --action "POST" \                   # or "POST_FAIL" on error
  --service "<source-repo>" \         # e.g. "github/Simmons-Systems/wiki"
  --reason "<user-provided reason>" \
  --target "<session-id>" \
  --payload '{"prompt": "...", ...}'  # optional structured data
```

Emits on both success and failure (`POST` vs `POST_FAIL`).
Inkwell failures are **swallowed** — mutations must never be blocked by audit issues.

Fallback: if `inkwell-emit` is not available (public distribution), write JSONL to
`~/.local/share/jules-mcp/audit.jsonl` instead.

### Metrics
Pass through any rate-limit headers from the Jules API in tool responses.
No Prometheus/StatsD for v1 — revisit if we go remote HTTP.

## Tech Stack

- **Language**: TypeScript
- **Framework**: `@modelcontextprotocol/sdk` (official MCP SDK)
- **HTTP client**: built-in `fetch` (Node 18+)
- **Auth**: API key from env var `JULES_API_KEY`
- **Transport**: stdio (plugin MCP)
- **Testing**: Vitest + smoke test script
- **Scheduling**: node-cron (in-process), with encrypted persistence via AES-256-GCM
- **Audit**: inkwell-emit CLI (with JSONL file fallback)

## Project Structure

```
jules-mcp/
├── package.json
├── tsconfig.json
├── DESIGN.md              ← this file
├── LICENSE                 ← MIT
├── src/
│   ├── index.ts           ← MCP server entry point, tool registration
│   ├── jules-client.ts    ← typed HTTP client for the Jules API
│   ├── tools/
│   │   ├── sources.ts     ← list_sources, get_source
│   │   ├── sessions.ts    ← create, list, get, approve, send_message
│   │   ├── activities.ts  ← list, get
│   │   ├── scheduling.ts  ← schedule_task, list_schedules
│   │   └── convenience.ts ← run_task (composite create+poll+approve)
│   ├── scheduler/
│   │   ├── cron.ts        ← node-cron wrapper, schedule management
│   │   └── persistence.ts ← AES-256-GCM encrypted schedule storage
│   ├── audit.ts           ← inkwell-emit wrapper with JSONL fallback
│   ├── errors.ts          ← structured error types
│   ├── formatters.ts      ← output formatting (plans, activities, diffs)
│   └── types.ts           ← TypeScript types matching Jules API schemas
├── tests/
│   ├── jules-client.test.ts
│   ├── tools/
│   │   ├── sources.test.ts
│   │   ├── sessions.test.ts
│   │   ├── activities.test.ts
│   │   ├── scheduling.test.ts
│   │   └── convenience.test.ts
│   ├── audit.test.ts
│   ├── scheduler.test.ts
│   └── formatters.test.ts
├── scripts/
│   └── smoke-test.ts      ← hits real API with a test session
└── .claude/
    └── settings.json      ← plugin MCP config
```

## What We're Taking from Each Community Repo

| Idea | Source | Adaptation |
|------|--------|------------|
| Clean 8-tool API surface mapping | Omarbadran37 | Expanded to 12 tools (activities split, scheduling, convenience). Proper input normalization. |
| Test infrastructure (Vitest + smoke tests) | savethepolarbears | Vitest for unit tests. Smoke test script that hits real API. |
| Structured project layout | savethepolarbears | Similar separation — `tools/`, `scheduler/`, `types`. |
| Security: never log API keys, generic error messages | savethepolarbears | Key from env var, never in logs. |
| In-process cron scheduling | savethepolarbears | Keeping this — not everyone uses n8n. Encrypted persistence with AES-256-GCM. |
| **NOT taking**: Cookie auth, browser automation | samihalawa | Hard no — fragile, ToS-violating |
| **NOT taking**: Activepieces integration | savethepolarbears | Out of scope — keep the server platform-agnostic |
| **NOT taking**: Build artifacts in repo | Omarbadran37 | Proper .gitignore, build on install |

## House Patterns (from existing SimmonsSystems MCP servers)

| Pattern | Implementation |
|---------|---------------|
| Inkwell audit logging | `inkwell-emit` CLI with JSONL fallback |
| `reason` on mutations | Required string param on create/approve/send/schedule |
| `dry_run` on mutations | Optional bool, returns `would_request` without calling API |
| Structured errors | Typed error classes with `message`, `statusCode`, `hint` |
| Error response shape | `{"status": "ERROR", "message": ..., "code": ...}` |
| Emit on failure too | `POST_FAIL` action in audit log |
| Swallow audit failures | Audit issues never block the mutation |

## Decisions (Resolved)

1. **`require_plan_approval` defaults to `true`** — safer; Claude sees the plan before
   Jules executes. Users can override per-session.
2. **`jules_run_task` convenience tool included** — composite create+poll+approve for
   fire-and-forget usage. Reports progress via MCP progress notifications.
3. **v1alpha breakage** — #YOLO. Pin to v1alpha, move fast. If it breaks, we fix it.
   No version-negotiation complexity.
4. **Scheduling included** — in-process cron with encrypted persistence. Not everyone
   has n8n or wants to set up external automation for recurring tasks.

## Future Considerations

- **Remote HTTP deployment** for broader distribution (Cloudflare Workers or similar)
- **Bulk operations**: create multiple sessions from a list of tasks
- **Source auto-discovery**: if only one source exists, auto-select it in `create_session`
- **MCP app widgets**: rich session status dashboard, plan review UI
- **npm publish**: `@simmons-systems/jules-mcp` or similar
