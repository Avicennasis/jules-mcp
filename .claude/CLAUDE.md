# jules-mcp

MCP server wrapping the Google Jules coding-agent API (v1alpha). 19 tools, TypeScript, 89 tests.

## Build & Test

```bash
npm run build        # tsc → dist/
npm test             # vitest run (89 tests, no API key needed)
npm run smoke        # live API smoke test (needs JULES_API_KEY)
npm run dev          # tsc --watch
npm start            # run the built server (stdio)
```

## Architecture

- `src/jules-client.ts` — typed HTTP client for the Jules REST API
- `src/tools/` — one file per tool group (sources, sessions, activities, scheduling, convenience, diff)
- `src/formatters.ts` — human-readable output formatting
- `src/audit.ts` — inkwell-emit wrapper + JSONL fallback
- `src/source-config.ts` — local per-source metadata store
- `src/scheduler/` — node-cron manager + AES-256-GCM encrypted persistence
- `tests/` — unit tests mock `fetch` and the filesystem; no API key needed

## Conventions

- All mutations require a `reason` string for the audit trail.
- Destructive tools (`jules_delete_session`) require `confirm_destructive: true`.
- `dry_run` on create/schedule returns the would-be request without calling the API.
- Input normalization: `session_id` / `source` accept bare IDs or full resource names.
- Error classes: `JulesAuthError`, `JulesNotFoundError`, `JulesRateLimitError`, `JulesStateError`, `JulesAPIError`.
- Requests carry a 30s timeout via `AbortSignal.timeout`.

## Key API Quirks

- Activity union fields are **top-level**, not nested under an `activity` key.
- proto3 omits default-value fields (`PlanStep.index` absent when 0).
- `sendMessage` body field is `prompt`, not `message`.
- Diffs live in activity artifacts, not `session.outputs` (often empty).
- `:archive`, `:unarchive`, `DELETE` are undocumented but work.

## Environment

- `JULES_API_KEY` (required) — sent as `X-Goog-Api-Key` header
- `JULES_ENCRYPTION_KEY` (optional) — passphrase for encrypted schedule persistence
- Local data at `~/.local/share/jules-mcp/` (schedules.enc, source-config.json, audit.jsonl)
