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

## MCP Tools (19 total)

> Counts here are asserted against `src/tools/` by `tests/readme-counts.test.ts`
> (Redmine #50462). This section previously read "15 total" and omitted the local
> source-config tools and the entire diff group — a design doc listing 15 of 19
> tools is the same class of defect as the README's stale test count.

### Sources (4 tools)

| Tool                        | Jules API           | Description                                                                                     |
| --------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `jules_list_sources`        | `GET /sources`      | List connected GitHub repos. Auto-paginates; supports AIP-160 `filter`. Branch lists opt-in.    |
| `jules_get_source`          | `GET /sources/{id}` | Get details for a specific source.                                                              |
| `jules_configure_source`    | N/A (local)         | Record per-repo metadata the API does not expose (e.g. suggestions enabled). Requires `reason`. |
| `jules_list_source_configs` | N/A (local)         | List all locally-stored source configurations.                                                  |

### Sessions (8 tools)

| Tool                      | Jules API                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jules_create_session`    | `POST /sessions`                  | Create a coding task. Params: `prompt` (required), `source` (required — source name), `starting_branch` (required), `title` (optional), `require_plan_approval` (optional, default **true**), `automation_mode` (optional — `AUTO_CREATE_PR` to auto-PR).                                                                                                                                                                                                                                                    |
| `jules_list_sessions`     | `GET /sessions`                   | List sessions with pagination. Params: `page_size`, `page_token`, `max_pages` (auto-follow; default 1, or 10 with `source`, hard cap 20), `source`, `state`, `stale_only`, `compact`, `detect_changes`, `detect_duplicates` — all optional. Everything after `max_pages` filters **client-side over the pages fetched**, so a count is only a total once the response carries no `nextPageToken`. `detect_changes` (implied by `stale_only`) spends one `GET /sessions/{id}/activities` per matched session. |
| `jules_get_session`       | `GET /sessions/{id}`              | Get session status, state, outputs. Use to poll progress or check for PR links.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `jules_approve_plan`      | `POST /sessions/{id}:approvePlan` | Approve a pending plan. Only valid when state is `AWAITING_PLAN_APPROVAL`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `jules_send_message`      | `POST /sessions/{id}:sendMessage` | Send feedback/instructions to Jules. Used when state is `AWAITING_USER_FEEDBACK` or to provide additional context. Params: `message` (required).                                                                                                                                                                                                                                                                                                                                                             |
| `jules_archive_session`   | `POST /sessions/{id}:archive` ¹   | Archive (close out) a session and hide it from the active list. Reversible. Params: `reason` (required).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `jules_unarchive_session` | `POST /sessions/{id}:unarchive` ¹ | Restore a previously archived session. Params: `reason` (required).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `jules_delete_session`    | `DELETE /sessions/{id}` ¹         | Permanently delete a session (irreversible). Guarded by `confirm_destructive`. Params: `reason` (required), `confirm_destructive`.                                                                                                                                                                                                                                                                                                                                                                           |

> ¹ **Undocumented endpoints.** The `:archive`, `:unarchive`, and `DELETE` operations are not listed in the [public Jules API reference](https://developers.google.com/jules/api) as of June 2026. They work reliably in practice but could change without notice. If they break, check the API docs for replacements before filing a bug.

### Activities (2 tools)

| Tool                    | Jules API                                     | Description                                                                                                                                                                     |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jules_list_activities` | `GET /sessions/{id}/activities`               | List activity log for a session. Shows messages, plans, progress updates, completion/failure. Params: `session_id` (required), `page_size` (optional), `page_token` (optional). |
| `jules_get_activity`    | `GET /sessions/{id}/activities/{activity_id}` | Get a single activity with full detail — includes artifacts (changesets, git patches, bash output, media).                                                                      |

### Scheduling (2 tools)

| Tool                   | Jules API         | Description                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jules_schedule_task`  | N/A (server-side) | Schedule a recurring coding task. Params: `cron` (cron expression), `prompt` (required), `source` (required), `starting_branch` (required), `label` (human-readable name), `require_plan_approval` (optional, default true), `automation_mode` (optional). Schedules are persisted locally with AES-256-GCM encryption. |
| `jules_list_schedules` | N/A (server-side) | List/manage scheduled tasks. Params: `action` (`list` / `delete`), `schedule_id` (for delete).                                                                                                                                                                                                                          |

### Convenience (1 tool)

| Tool             | Jules API | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jules_run_task` | composite | Create a session, poll until plan is ready, auto-approve, poll until completion, return results. One-shot "fire and forget" for when you trust Jules to just do the thing. Params: same as `create_session` plus `auto_approve` (default true), `poll_interval_ms` (default 5000), `timeout_ms` (default 600000 / 10 min), `parallel` (1–10, fans out N independent sessions). **Does not** report MCP progress notifications — see decision 2 and Redmine #50418. |

### Diff & review (2 tools)

| Tool                     | Jules API | Description                                                                                                                                                                                                                 |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jules_get_session_diff` | composite | Review-friendly view: header + plan + the **final** changeset, binary blobs summarized rather than dumped. `summary=true` returns files + `+/-` counts only. Walks activities, since `session.outputs` is frequently empty. |
| `jules_pull_session`     | composite | Extract the final changeset as a `git apply`-ready unified diff, plus suggested commit message and per-file `+/-` summary. Mirrors the Jules CLI's `remote pull`.                                                           |

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

**Last surveyed 2026-08-23** (8 repos, read at code depth — cloned and read, not README-skimmed).
Superseded the original design-time table, which covered 3 repos and described us as a
12-tool server. We ship **19 tools**. Every row below links the Redmine ticket carrying
the finding; the tickets hold the file:line citations and acceptance criteria.

### Adopted at design time (original table, still true)

| Idea                                                 | Source            | Adaptation                                                                        |
| ---------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| Clean 8-tool API surface mapping                     | Omarbadran37      | Expanded to **19 tools** (activities split, scheduling, convenience, diff group). |
| Test infrastructure (Vitest + smoke tests)           | savethepolarbears | Vitest for unit tests. Smoke test script that hits real API.                      |
| Structured project layout                            | savethepolarbears | Similar separation — `tools/`, `scheduler/`, `types`.                             |
| Security: never log API keys, generic error messages | savethepolarbears | Key from env var, never in logs.                                                  |
| In-process cron scheduling                           | savethepolarbears | Keeping this — not everyone uses n8n. Encrypted persistence with AES-256-GCM.     |

### Open from the 2026-08-23 survey

| Idea                                                               | Source                                            | Ticket                         |
| ------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------ |
| Retry + backoff honoring `Retry-After` (4 impls to compare)        | georgeracu, MikBin, CodeAgentBridge, TheNovaNodes | #50416, #50447, #50451, #50461 |
| MCP **prompts** primitive — reusable task templates                | savethepolarbears                                 | #50429                         |
| MCP **resources** primitive — sessions/sources/diffs               | savethepolarbears                                 | #50430                         |
| MCP resources as troubleshooting runbooks                          | samihalawa                                        | #50453                         |
| `ToolAnnotations` + `structuredContent` + tool tags                | MikBin, CodeAgentBridge                           | #50443, #50450                 |
| MCP progress notifications during long polls                       | georgeracu                                        | #50418                         |
| Char-budget truncation with in-band recovery hints                 | georgeracu                                        | #50417                         |
| Patch truncation with explicit truncated/length flags              | MikBin                                            | #50444                         |
| Server-side activity filter `createTime>ISO` (only novel API find) | savethepolarbears                                 | #50436                         |
| `include_archived` session listing                                 | MikBin                                            | #50445                         |
| `check_jules` cheap status + source auto-resolution                | MikBin                                            | #50441                         |
| `workingBranch` / `environmentVariablesEnabled` on create          | MikBin                                            | #50442                         |
| Repoless sessions (no `sourceContext`)                             | savethepolarbears                                 | #50435                         |
| `create_session_from_issue`                                        | maxnoller                                         | #50457                         |
| `get_pr_url` / `get_last_message` reductions                       | GreyC                                             | #50458                         |
| Secret-scan prompts before transmission                            | savethepolarbears                                 | #50431                         |
| `JULES_ALLOWED_REPOS` allowlist                                    | savethepolarbears                                 | #50432                         |
| Quota-aware cron gate (reject sub-hourly, 6-field cron)            | savethepolarbears                                 | #50433                         |
| Dedicated `jules_delete_schedule` tool                             | savethepolarbears                                 | #50434                         |
| Schedule-store hardening (atomic rename, corrupt backup)           | savethepolarbears                                 | #50437                         |
| Completion notification via `updateTime` watermark                 | savethepolarbears                                 | #50438                         |
| MSW network-layer test interception                                | georgeracu                                        | #50419                         |
| Activity-union + omitted-field test fixtures                       | georgeracu                                        | #50420                         |
| Path-segment URL encoding (**fixed** — `d279e12`)                  | georgeracu                                        | #50421                         |
| npm publish / MCP Registry / OIDC release pipeline                 | georgeracu, GreyC, CodeAgentBridge                | #50422, #50459, #50449         |
| Multi-stage Dockerfile                                             | samihalawa                                        | #50456                         |
| Measure real Jules quota (field claims conflict)                   | georgeracu, savethepolarbears                     | #50428                         |

### NOT taking — reconfirmed 2026-08-23

| Decision                                     | Source            | Why, with the evidence that reconfirmed it                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cookie auth, browser automation**          | samihalawa        | Hard no — fragile, ToS-violating. Reconfirmed and strengthened: that repo commits a **live third-party API key** in `smithery.yaml`, tracks `node_modules/` (2,359 files), and its `jules_get_cookies` tool dumps raw Google SID cookies into model context. Its Angular selectors are near-certainly rotted since 2025-12. |
| **Activepieces integration**                 | savethepolarbears | Out of scope — keep the server platform-agnostic. The genuinely useful part, the `updateTime` watermark poller, is extracted platform-agnostically in #50438.                                                                                                                                                               |
| **Build artifacts in repo**                  | Omarbadran37      | Proper .gitignore, build on install.                                                                                                                                                                                                                                                                                        |
| **GitHub-API PR creation inside the server** | maxnoller         | Their headline "automatic PR creation" is just `automationMode: AUTO_CREATE_PR` — the flag we already pass. No GitHub call exists in that repo. We keep relying on Jules' automation mode plus `jules_pull_session`.                                                                                                        |

**Not yet surveyed:** `Omarbadran37` — cited in the original design-time table but **not** part
of the 2026-08-23 code-depth pass. Re-examine before treating its rows above as current.

## House Patterns (from existing SimmonsSystems MCP servers)

| Pattern                | Implementation                                             |
| ---------------------- | ---------------------------------------------------------- |
| Inkwell audit logging  | `inkwell-emit` CLI with JSONL fallback                     |
| `reason` on mutations  | Required string param on create/approve/send/schedule      |
| `dry_run` on mutations | Optional bool, returns `would_request` without calling API |
| Structured errors      | Typed error classes with `message`, `statusCode`, `hint`   |
| Error response shape   | `{"status": "ERROR", "message": ..., "code": ...}`         |
| Emit on failure too    | `POST_FAIL` action in audit log                            |
| Swallow audit failures | Audit issues never block the mutation                      |

## Decisions (Resolved)

> **Audited against the source 2026-09-05 (#50463).** Decision 2's claim about MCP
> progress notifications was found false in 2026-08 — under a heading a future
> implementer trusts more than an open TODO, which is what made it expensive. Every
> other decision now carries the evidence it was checked against and the date, so the
> next reader can tell a verified statement from an inherited one. Decision 5 was added
> the same day and records a live conflict between two tickets rather than hiding it.

1. **`require_plan_approval` defaults to `true`** — safer; Claude sees the plan before
   Jules executes. Users can override per-session. Verified 2026-09-05: `.default(true)`
   on the zod schema in `src/tools/sessions.ts:56-58` and `src/tools/scheduling.ts:47-50`.

    **Two things the original wording left out, both of which change what the default
    buys you.** The literal claim is true; the safety it implies is narrower.

    - **`jules_run_task` discharges the gate immediately by default.** It hardcodes
      `requirePlanApproval: true` on creation (`convenience.ts:239`, `:341`) and then
      exposes `auto_approve`, which **defaults to `true`** (`:178-181`). So Jules is
      asked to pause, and we approve on its behalf without a human seeing the plan.
      `auto_approve` controls whether _we_ approve, not whether Jules skips — pass
      `auto_approve: false` if you want the plan to reach a person.
    - **Approval carries forward across revisions**, measured against the live API on
      2026-08-31 (#50640). Once a plan is approved, sending a revision produces a new
      plan that executes straight through — no second `AWAITING_PLAN_APPROVAL`. The
      gate is one-shot, not standing: **revise before approving** if it matters.

2. **`jules_run_task` convenience tool included** — composite create+poll+approve for
   fire-and-forget usage, with `parallel` (1–10) fanning out N independent sessions.
   **NOT BUILT: MCP progress notifications.** This line used to assert we report
   progress via `notifications/progress`. We do not, and never did — there is no
   `progressToken`, `sendNotification` or `_meta` handling in
   `src/tools/convenience.ts`. `jules_run_task` polls blind for up to 600s with no
   client feedback and no cancellation path. The intent stands and is tracked in
   **Redmine #50418**; corrected under **#50463**. The same false claim also sat in
   the Convenience tool table above and is corrected there too — when retiring a
   claim, grep the whole document for it rather than fixing the instance you found.
   Do not re-state this as done until #50418 closes.
3. **v1alpha breakage** — #YOLO. Pin to v1alpha, move fast. If it breaks, we fix it.
   No version-negotiation complexity. Verified 2026-09-05: one `BASE_URL` in
   `src/jules-client.ts:18`, and no other API version string appears anywhere in `src/`.
4. **Scheduling included** — in-process cron with encrypted persistence. Not everyone
   has n8n or wants to set up external automation for recurring tasks. Verified
   2026-09-05: `node-cron` imported in `src/scheduler/cron.ts:1`; `aes-256-gcm` via
   `crypto.createCipheriv` in `src/scheduler/persistence.ts:9,56`.
5. **Retries are idempotency-aware, and a request TIMEOUT is never retried** — a `429`
   replays for every method including `POST`; a `5xx` or network failure replays only
   for `GET`/`HEAD`/`OPTIONS`/`PUT`/`DELETE`. A 429 means the request was rejected
   without being processed; a 5xx or dropped socket is ambiguous, and Jules offers no
   idempotency key, so replaying `POST /sessions` can double-create against a daily
   quota whose ceiling is unmeasured (**#50428**).

    **On timeouts specifically — this resolves a conflict between two tickets, and it
    is worth naming rather than burying.** **#50447** (from `MikBin/jules-mcp`) asks for
    "timeout retries permitted for idempotent reads only" and a test that a timing-out
    read is retried. **#50643** (from `Yuuqq/jules-dispatch`) says a timeout is
    "never retried", and its own filing designates it the reference implementation to
    prefer at triage. We followed #50643.

    The reasoning, so it can be overruled on its merits: the 30s deadline is _ours_, set
    per request by the caller via `requestTimeoutMs`. Retrying a timed-out read spends
    another full deadline the caller did not ask for — three attempts turn a stated 30s
    bound into 90s inside a single MCP tool call, with no way for the client to see it
    happening. A caller who wants longer should raise `requestTimeoutMs`, which says so
    explicitly, rather than get it silently multiplied. A 429 or 5xx is the server
    telling us something; a timeout is only us running out of patience.

    The guard is about **precedence**, not the empty case: a bare timeout with no status
    and no network flag is already unretryable for want of any retryable signal. It
    earns its keep when a runtime surfaces the deadline as a `TypeError`, which
    otherwise reads as a retryable network failure on an idempotent method.

    If this decision is reversed, the change is one branch in `planRetry` plus its
    precedence tests — see `src/retry.ts` and `tests/retry.test.ts`.

    Redmine **#50643**, resolving the open question in **#50447**.

## Future Considerations

- **Remote HTTP deployment** for broader distribution (Cloudflare Workers or similar)
- **Bulk operations**: create multiple sessions from a list of tasks
- **Source auto-discovery**: if only one source exists, auto-select it in `create_session`
- **MCP app widgets**: rich session status dashboard, plan review UI
- **npm publish**: `@simmons-systems/jules-mcp` or similar
