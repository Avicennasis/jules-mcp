# Contributing to jules-mcp

Thanks for considering a contribution. Bug reports, docs fixes, and small
improvements are all welcome.

## Dev setup

```bash
git clone https://github.com/Avicennasis/jules-mcp.git
cd jules-mcp
npm ci
npx pre-commit install   # or: pre-commit install (if installed globally)
```

## Running the tests

```bash
npm test
```

CI runs the tests against the configured Node.js LTS matrix — make sure they
pass locally before opening a PR.

## Code style

Lint/format hooks are wired via pre-commit. `pre-commit run --all-files`
runs the full check locally.

## PR checklist

- [ ] Tests added or updated; `npm test` is green locally.
- [ ] `pre-commit run --all-files` is clean.
- [ ] README and docs updated if public behavior changed.
- [ ] `CHANGELOG.md` updated under `[Unreleased]`.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
Be respectful; assume good faith.
