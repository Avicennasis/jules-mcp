# Changelog

All notable changes to `jules-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
