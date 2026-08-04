# Changelog

This changelog records the cumulative downstream changes in [`jihuanshe/linear`](https://github.com/jihuanshe/linear) relative to its upstream baseline. Rolling builds from `main` use commit-derived versions, so exact build-by-build history lives in [GitHub Releases](https://github.com/jihuanshe/linear/releases) and Git history rather than duplicated numbered entries here.

## Downstream changes since upstream 2.3.0

### Agent and automation contracts

- Added `LINEAR_PROMPT_DISABLED=1` to make interactive prompts fail instead of reading stdin. It never selects a default, grants consent, or replaces an explicit mutation flag.
- Made non-TTY, `NO_COLOR`, `TERM=dumb`, and `CLICOLOR=0` output colorless, while keeping stdout data separate from stderr diagnostics and pager decisions.
- Standardized usage errors on stderr with exit code `2`; validation and runtime failures continue to use exit code `1`.
- Added machine-readable output for `auth whoami`, `team list`, `project list`, `project view`, and `issue update`.
- Preserved GraphQL field names and connection shape in JSON. Paginated lists concatenate `nodes`, retain `pageInfo`, validate `--limit`, and stop at a requested bound without losing the continuation cursor.
- Kept JSON, terminal styling, pagination, prompting, and mutation consent as independent contracts instead of introducing an all-in-one agent mode.

### Mutation safety and correctness

- Added incremental `issue update --add-label` and `--remove-label` operations alongside explicit label-set replacement.
- Required at least one explicit update option for non-interactive `issue update` calls.
- Added UUID support for single and bulk issue deletion.
- Made `team delete --dry-run` non-interactive and mutation-free, and moved the final confirmation before any issue migration begins.
- Validated explicit issue-migration targets even when the source team is empty, and report each completed identifier mapping immediately so partial progress remains visible after a later failure.
- Renamed the command-level workspace-label selector to `label list --workspace-labels` so it no longer conflicts with the global `--workspace <slug>` credential selector.
- Restricted plaintext credential files to owner read/write permissions on non-Windows systems.

### Development and distribution

- Added a reproducible Amp Orb setup around Deno `2.7.9`, with checkout-isolated CLI installs and dependency caching.
- Added a full verification gate covering GraphQL generation, formatting, linting, type checking, unit tests, keyring integration, and generated Skill documentation.
- Ship every verified `main` commit as five public GitHub binaries named `0.0.<commit timestamp>-g<short commit>`, with checksums and build provenance.
- Cancel stale overlapping release runs so only the newest pushed `main` commit continues building.
- Documented mise installation from `github:jihuanshe/linear`; source-controlled versions remain `0.0.0-dev`.

### Repository and documentation

- Rewrote the README around this fork's automation contracts, current installation path, upstream attribution, and contribution workflow.
- Moved reusable Agent Skills to the standard `.agents/skills/` layout and removed Claude plugin packaging, Claude-specific settings, and Zed-specific settings.
- Corrected the Deno manifest license metadata to ISC, matching the repository's inherited license.

## Upstream baseline and credits

This fork is based on [`schpet/linear-cli` 2.3.0](https://github.com/schpet/linear-cli/releases/tag/v2.3.0), created by [Peter Schilling](https://github.com/schpet) and developed by its [contributors](https://github.com/schpet/linear-cli/graphs/contributors).

The complete history through that baseline remains available in the [upstream changelog](https://github.com/schpet/linear-cli/blob/v2.3.0/CHANGELOG.md) and [upstream releases](https://github.com/schpet/linear-cli/releases). This downstream changelog intentionally does not copy or relabel those releases.
