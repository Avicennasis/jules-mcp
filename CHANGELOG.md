# Changelog

All notable changes to `jules-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Comment-only change detection: `jules_get_session_diff` now emits a
  `[comment-only]` review warning naming any file whose entire diff is
  comments. Such changes cannot fail a test or break CI, so they are invisible
  to every automated signal — this flags them for a human read. It is a review
  prompt, not a gate (#37).
- Standing guidance on `jules_create_session`: house rules on comment
  preservation and on declining tasks whose premise is wrong are prepended to
  the prompt by default. The text lives in `guidance.md` under the config dir
  (`~/.local/share/jules-mcp/`) and falls back to a built-in default, so it can
  be edited without a release. Opt out per call with `include_guidance: false`.
  Note this reaches only tasks created through this server — Jules' own
  auto-generated suggestion tasks are created upstream and never pass through
  here (#38).
- `jules_list_sessions` gains `stale_only`, selecting sessions that are
  awaiting user feedback **and** produced no code changes — no PR, no diff,
  waiting on feedback nobody is going to give. These accumulate: 37 of one
  repo's 104 sessions were in that state, nearly all repeated persona runs.
  This is the missing first half of the "show me the dead ones, archive them"
  workflow that `jules_archive_session` already completes. It implies
  `detect_changes`, narrows by state first so excluded sessions cost no API
  call, and treats a failed activities fetch as unknown rather than as "no
  changes". A general `state` filter is available alongside it (#36).

### Changed

- `jules_list_sources` no longer returns every branch of every repo by default.
  Branch counts grow without bound as Jules opens task branches, and the list
  is usually irrelevant to the question being asked — measured across the 474
  real connected sources, branches were 5,227 entries and 72.7% of the payload
  (513,460 → 140,410 characters), with one repo carrying 515 on its own. Each
  repo now reports `branchCount` and keeps `defaultBranch`; pass
  `include_branches: true` for the full lists (#33).

- `jules_run_task` parallel mode now polls all N sessions to completion
  concurrently (auto-approving plans per session) and returns a per-session
  outcome summary (`OK`/`PARTIAL`), matching the tool description instead of
  returning immediately after creation. Parallel sessions are also created
  with `requirePlanApproval: true` like single mode — `auto_approve` controls
  whether the tool approves, not whether Jules skips approval (#47978).
- `JulesClient` request timeout is configurable: per client via
  `new JulesClient(key, { requestTimeoutMs })` or per call; default remains
  30s (#47977).

### Fixed

- `jules_send_message` failed on every call with
  `TypeError: Cannot read properties of undefined (reading 'source')` (500).
  The `:sendMessage` endpoint returns `google.protobuf.Empty`, so the response
  carries no session fields, but the handler read `session.sourceContext.source`
  for its audit entry. The throw happened **after** the POST had already
  succeeded, so a delivered message was reported to the caller as a hard
  failure — inviting a duplicate retry. `JulesClient.request` now treats an
  empty response body as an empty result instead of a JSON parse error,
  `sendMessage` returns `Session | undefined` to make the empty payload
  explicit in the type, and the tool re-reads the session for real state. If
  that re-read fails the tool still reports success, because the message was
  delivered (#30).
- `jules_list_activities` and `jules_get_activity` returned
  `TypeError: Cannot read properties of undefined (reading 'split')` (500) for
  any session whose log contained a `changeSet` artifact with no diff, making
  the activity log unreadable for real sessions. proto3 omits fields holding
  the default value, so `gitPatch` arrives with no `unidiffPatch` key at all;
  the type declared it required, which let the unguarded deref typecheck. The
  `GitPatch`, `Plan` and activity union-member types are now optional to match
  the wire format, and each line is emitted only when its field is present.
  This also stops the quieter half of the same bug: absent fields were being
  interpolated into output as the literal string `undefined` — most visibly
  `Progress: undefined — undefined`, which was the majority case at 15 of 27
  progress activities in a real session (#42).
- `compact: true` on `jules_list_sessions` did not produce one-line rows. Jules
  sets `title` to the entire task prompt — multi-KB markdown with headings and
  fenced code for generated tasks — so rows ran to dozens of lines and the flag
  failed in exactly the high-session-count case it exists to serve.
  `formatSessionCompact` now takes the first non-blank line of the title and
  caps it at `COMPACT_TITLE_MAX_CHARS` (120), marking a truncated title with an
  ellipsis. Measured on the 104 real GrantLoft sessions: **1,122 lines → 104**
  (one per session), 47,213 → 11,490 characters (#32).
- `jules_list_sources` with `suggestions_only` printed a definitive
  `suggestionsQuota` derived from a scan that could stop early, so the same
  question returned "2/5 slots used" or "4/5 slots used" depending on how many
  pages happened to be scanned. `suggestions_only` filters the whole source
  list, so it now scans to exhaustion by default (up to the 20-page cap); an
  explicit `max_pages` is still honoured, but any truncated scan now renders as
  `at least N of 5 slots used — SCAN INCOMPLETE …` and sets
  `suggestionsScanComplete: false`, so a lower bound can no longer be read as a
  count. Reproduced against the live account: 474 sources over 5 pages, with
  suggestions-enabled repos on pages 1 and 4 (#31).
- `suggestionsEnabled` is local bookkeeping that was presented as though it
  were live Jules state. Confirmed against the API across all 474 sources: a
  source carries only `name`, `id` and `githubRepo` — suggestion state is not
  exposed anywhere, so it cannot be reconciled. Every tool that reports the
  quota now labels it as local, names the file it came from, and publishes the
  age of the oldest record (`suggestionsOldestRecord`,
  `suggestionsRecordAgeDays`, `suggestionsStale` past 30 days) (#35).
- `detect_duplicates` reported "these two sessions edit the same file" and
  "these two sessions edit the same lines" identically, so two complementary
  changes to different functions of one file looked exactly like real
  duplication — acting on the flag without reading both diffs could close
  legitimate work. `summarizeChangeset` now records each file's post-image
  hunk ranges from the `@@` headers, and every duplicate match carries a
  strength: `overlapping-hunks` (the edits collide), `same-file` (shared path,
  disjoint regions) or `similar-title` (titles only). The feature is
  deliberately not narrowed — clustering repeated persona runs is its main
  value — so pairs are still flagged, just labelled. `detectDuplicates` now
  returns `Map<string, DuplicateMatch[]>` rather than `Map<string, string[]>`
  (#34).

### Security

- Audit payloads are passed to `inkwell-emit` via stdin (`--payload -`)
  instead of a CLI argument, keeping prompt text out of
  `/proc/PID/cmdline` (#47975).
- The auto-generated schedule encryption key file is re-tightened to mode
  `0600` on every load, and the README now documents why multi-user systems
  should prefer `JULES_ENCRYPTION_KEY` from a secret manager (#47976).

## [0.4.0] - 2026-06-23

### Added

- `jules_pull_session`: extract the final unified diff from a completed session
  as a `git apply`-ready patch. Returns the raw patch, suggested commit message,
  and a per-file summary. Inspired by the Jules CLI's `remote pull` command.
- `jules_run_task` `parallel` param (1–10): fan out N independent sessions with
  the same prompt, matching the Jules CLI's `--parallel` flag. Creates all
  sessions concurrently and returns their IDs for polling.
- `jules_list_sources` now supports `page_size`, `page_token`, `filter`
  (AIP-160 expressions), and `max_pages` for auto-pagination — matching the API
  surface that was previously unused.
- `jules_configure_source`: set local per-source metadata that the Jules API
  doesn't expose (e.g. whether "suggestions" is enabled in the web UI). Stored
  at `~/.local/share/jules-mcp/source-config.json`.
- `jules_list_source_configs`: list all locally-stored source configurations.
- `jules_list_sources` and `jules_get_source` now annotate responses with
  `localConfig` when a source has local configuration set.
- Activity `description` field is now surfaced as a `Note:` line when present
  alongside a typed union member, instead of being silently dropped.

### Changed

- `jules_list_sources` return shape changed from a flat array to
  `{ status, count, pagesFetched, sources, nextPageToken? }` to match the
  paginated pattern used by `jules_list_sessions`.
- MCP server version string bumped to `0.4.0` (was still `0.2.0`).

### Documentation

- DESIGN.md: flagged `:archive`, `:unarchive`, and `DELETE` as undocumented
  API endpoints with a footnote about potential breakage.
- README.md: updated tool count (19), added new tools to reference tables,
  updated project layout, corrected test counts, refreshed roadmap.

## [0.3.0] - 2026-06-20

### Added

- Initial project scaffolding.
- `jules_list_sessions`: `source` filter (find sessions for one repo without
  dumping every connected repo), `compact` one-line-per-session output,
  `detect_changes` to annotate which sessions produced code vs. a plan only,
  and `max_pages` to scan past the first page (defaults to 10 when `source`
  is set).
- `jules_get_session_diff`: `summary` mode returning changed files with
  `+/-` line counts instead of the full diff, for large changesets.
- `jules_archive_session` and `jules_unarchive_session` — close out / reopen
  finished sessions (reversible). Backed by the `v1alpha` `:archive` /
  `:unarchive` endpoints, which were added to the API after the initial build.
- `jules_delete_session` — permanently delete a session (irreversible),
  guarded by a `confirm_destructive` flag.
- `Session.archived` is now surfaced in `formatSession` (an `Archived: true`
  line) and the compact listing (`[archived]` marker).

### Changed

- `jules_list_sessions` response now includes `pagesFetched` (and `scanned` /
  `filteredBy` when a `source` filter is applied).
- `JulesClient.request` now supports `DELETE` (returns no body).
