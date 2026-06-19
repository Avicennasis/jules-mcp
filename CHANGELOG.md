# Changelog

All notable changes to `jules-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
