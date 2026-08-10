# Changelog

This changelog records the cumulative downstream changes in [`jihuanshe/linear`](https://github.com/jihuanshe/linear) relative to its upstream baseline. Rolling published builds from `main` use commit-derived versions, so exact build-by-build history lives in [GitHub Releases](https://github.com/jihuanshe/linear/releases) and Git history rather than duplicated numbered entries here.

## Downstream changes since upstream 2.3.0

### Agent and automation contracts

- Added `LINEAR_PROMPT_DISABLED=1` to make interactive prompts fail instead of reading stdin. It never selects a default, grants consent, or replaces an explicit mutation flag.
- Made non-TTY, `NO_COLOR`, `TERM=dumb`, and `CLICOLOR=0` output colorless, while keeping stdout data separate from stderr diagnostics and pager decisions.
- Standardized usage errors on stderr with exit code `2`; validation and runtime failures continue to use exit code `1`.
- Added progressive `linear usage` and `linear <domain> usage` discovery, with optional JSON describing command arguments, options, aliases, write and interaction capabilities, confirmation requirements, and output modes.
- Added an offline `linear version --json` probe exposing stable distribution identity, release version, and additive protocol capabilities without conflating build identity with installation ownership.
- Added machine-readable output for `auth whoami`, `team list`, `project list`, `project view`, and `issue update`; update responses include the resulting priority and labels needed for immediate verification.
- Preserved GraphQL field names and connection shape in JSON. Paginated lists concatenate `nodes`, retain `pageInfo`, validate `--limit`, and stop at a requested bound without losing the continuation cursor.
- Kept JSON, terminal styling, pagination, prompting, and mutation consent as independent contracts instead of introducing an all-in-one agent mode.

### Guides and issue delivery

- Embedded five version-matched Chinese workflow guides (core, automation, issue-authoring, issue-delivery, graphql) into the binary behind `linear guides list/read`, with related-guide breadcrumbs in domain usage, leaf help, and usage JSON.
- Added `linear upload` so uploaded assets can be embedded at any Markdown position, including table cells and comments, with optional public image URLs.
- Added declarative issue delivery: `linear issue plan` previews a manifest with zero writes, concise create metadata, per-field three-way update verdicts (write/idempotent/conflict against a recorded base), and add/idempotent/conflict Relation verdicts that prevent a different edge from being replaced; `linear issue apply` executes it sequentially with per-item applied/failed/unknown/unattempted/skipped reporting and required final read-back. A successful mutation whose view cannot be read remains checkpointed and returns `applied-unverified` instead of a false completion.
- Made a manifest with multiple issues the batch form of the same protocol: a checkpoint beside the manifest records every mutation as in flight before launching it, skips confirmed successes on resume, refuses resumes after structural drift or unresolved unknown outcomes, and `--continue-on-failure` collects failures without stopping. Duplicate update targets are rejected before remote reads or checkpoint work so one Issue cannot partially mutate before a later entry conflicts.
- Normalized Linear's equivalent Markdown rewrites (seven observed forms with real-sample regressions) so round-trips stay idempotent instead of reporting false conflicts.
- Extended `version --json` capabilities to `usage-v1`, `guides-v1`, and `delivery-v1`, and removed the generated Skill manuals — command facts live only in the live command tree and version-matched guides.

### Mutation safety and correctness

- Added incremental `issue update --add-label` and `--remove-label` operations alongside explicit label-set replacement.
- Required at least one explicit update option for non-interactive `issue update` calls.
- Added UUID support for single and bulk issue deletion.
- Made `team delete --dry-run` non-interactive and mutation-free, and moved the final confirmation before any issue migration begins.
- Validated explicit issue-migration targets even when the source team is empty, and report each completed identifier mapping immediately so partial progress remains visible after a later failure.
- Renamed the command-level workspace-label selector to `label list --workspace-labels` so it no longer conflicts with the global `--workspace <slug>` credential selector.
- Restricted plaintext credential files to owner read/write permissions on non-Windows systems.

### Development and distribution

- Added a reproducible Amp Orb setup around Deno `2.9.4`, with a primary-checkout source wrapper on the Orb's stable command PATH and dependency caching.
- Added a local and pull request source gate (`deno task verify-release`) covering GraphQL generation, formatting, linting, type checking, and non-Keyring tests; release CI retains the isolated Linux Keyring integration test.
- Publish rolling builds from authorized `main` updates for five platforms as install archives and standalone self-update binaries named `0.0.<commit timestamp>-g<short commit>`, with checksums and build provenance.
- Record each successfully published GitHub Release as one completed Linear Release from that push's exact commit range, with the same version and a link to its GitHub Release.
- Serialize rolling release runs without canceling in-progress work, retain up to 100 pending `main` updates, and publish a distinct version for every successful run.
- Documented mise installation from `github:jihuanshe/linear`; source-controlled versions remain `0.0.0-dev`.
- Added `linear update`, delegating mise-managed installs back to mise while checksum-validating and atomically replacing binaries downloaded directly from GitHub Releases.

### Repository and documentation

- Rewrote the README around this fork's automation contracts, current installation path, upstream attribution, and contribution workflow.
- Moved reusable Agent Skills to the standard `.agents/skills/` layout and removed Claude plugin packaging, Claude-specific settings, and Zed-specific settings.
- Corrected the Deno manifest license metadata to ISC, matching the repository's inherited license.

## Upstream baseline and credits

This fork is based on [`schpet/linear-cli` 2.3.0](https://github.com/schpet/linear-cli/releases/tag/v2.3.0), created by [Peter Schilling](https://github.com/schpet) and developed by its [contributors](https://github.com/schpet/linear-cli/graphs/contributors).

The complete history through that baseline remains available in the [upstream changelog](https://github.com/schpet/linear-cli/blob/v2.3.0/CHANGELOG.md) and [upstream releases](https://github.com/schpet/linear-cli/releases). This downstream changelog intentionally does not copy or relabel those releases.
