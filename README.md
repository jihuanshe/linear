# Linear CLI

A human- and AI-agent-friendly, Git- and Jujutsu-aware command-line interface for [Linear](https://linear.app/).

Use it to inspect issues, start work, update Linear state, create pull requests, and automate Linear workflows without leaving the terminal.

> [!IMPORTANT]
> This repository, [`jihuanshe/linear`](https://github.com/jihuanshe/linear), is a downstream fork of [`schpet/linear-cli`](https://github.com/schpet/linear-cli).
>
> The original project was created by [Peter Schilling](https://github.com/schpet) and its contributors. Its CLI design, Git and Jujutsu integration, interactive workflows, and most of the command surface form the foundation of this fork.
>
> This fork is maintained by [Jihuanshe](https://github.com/jihuanshe) and may intentionally diverge from upstream. It focuses on predictable automation, machine-readable output, explicit mutation contracts, and safe use by AI agents.

This project is not an official Linear product and is not affiliated with or endorsed by Linear.

## Why this fork exists

The upstream CLI provides a productive terminal workflow for humans:

- infer the current Linear issue from Git branches or Jujutsu commit trailers;
- list, inspect, create, and update Linear entities;
- start an issue and create or switch to its branch;
- create GitHub pull requests with Linear context;
- open the correct Linear web or desktop view;
- work interactively without repeatedly switching to the Linear UI.

This downstream fork preserves those workflows while making the CLI easier to use as a stable tool boundary for AI agents and unattended automation.

Its current priorities are:

- structured JSON output with GraphQL-compatible field names and nesting;
- stable connection output in the form `{ "nodes": [], "pageInfo": {} }`;
- bounded pagination with explicit `--limit` behavior;
- clean stdout for machine-readable results;
- diagnostics, warnings, and errors on stderr;
- predictable exit codes for syntax, validation, and runtime failures;
- no colors, spinner, pager, or prompt leakage in non-interactive pipelines;
- global prompt suppression through `LINEAR_PROMPT_DISABLED=1`;
- explicit confirmation for destructive operations;
- incremental patch-style updates where replacement would be unnecessarily destructive;
- rolling binaries built directly from `main`.

It deliberately does **not** provide an all-in-one "agent mode." JSON output, terminal styling, pagination, prompting, and mutation consent remain separate contracts.

## Quick start

### Install with mise

Install the latest published build from `main`:

```bash
mise use -g "github:jihuanshe/linear[minimum_release_age=0s]@latest"
linear --version
linear version --json
```

mise selects the matching binary for macOS, Linux, or Windows. Deno and Node.js are not required at runtime.

`linear --version` preserves the conventional plain version string. `linear version --json` additionally identifies the `jihuanshe/linear` distribution and its additive protocol capabilities without authentication or network access. It identifies the build, not whether mise or another manager owns the executable.

`minimum_release_age=0s` applies only to this tool. It allows a newly shipped `main` build to be installed immediately; mise otherwise hides new GitHub releases for 24 hours by default.

Releases use versions of the form:

```text
0.0.<commit timestamp>-g<short commit>
```

Use `latest` to follow published `main` builds, or pin an exact version when reproducibility matters.

Prebuilt binaries and checksums are also available from [GitHub Releases](https://github.com/jihuanshe/linear/releases/latest).

### Update

Update the installed CLI with the same installation method:

```bash
linear update
```

For a mise-managed installation, this runs a tool-scoped `mise up` and respects the configured version selector. Use `linear update --bump` only when you intentionally want mise to rewrite a pinned selector. For a binary downloaded directly from GitHub Releases, `linear update` downloads the matching binary, checks its SHA-256 checksum, and replaces the current executable.

### Authenticate

Create a Linear personal API key at [Linear settings](https://linear.app/settings/account/security), then run:

```bash
linear auth login
```

To verify the selected account:

```bash
linear auth whoami
linear auth whoami --json
```

See [Authentication](docs/authentication.md) for environment-variable and multi-workspace configuration.

### Configure a repository

From a project repository:

```bash
linear config
```

This creates a `.linear.toml` containing the default Linear workspace and team.

## Human workflow

```bash
linear issue mine
linear issue query --search "login bug"
linear issue view ENG-123
linear issue start ENG-123
linear issue update ENG-123 --state "In Progress"
linear issue pr
```

The current issue can be inferred from:

- a Git branch containing an identifier such as `eng-123-fix-login`; or
- a `Linear-issue` trailer in the current or an ancestor Jujutsu commit.

Interactive commands remain available when stdin is a terminal and prompting has not been disabled.

## Agent and automation workflow

For unattended execution, disable all interactive prompts:

```bash
export LINEAR_PROMPT_DISABLED=1
```

This setting:

- prevents the CLI from displaying a prompt or reading a response from stdin;
- lets fully specified commands continue normally;
- causes commands with missing input or confirmation to fail explicitly;
- never selects a prompt default;
- never implies consent;
- never replaces `--force`, `--confirm`, or another explicit mutation flag.

Examples of read-only machine usage:

```bash
linear auth whoami --json
linear team list --json --limit 20
linear project list --all-teams --json --limit 20
linear issue query --all-teams --json --limit 50
```

Mutations should specify both the target and intended change:

```bash
linear issue update ENG-123 \
  --state "In Review" \
  --add-label reviewed \
  --json
```

Incremental options such as `--add-label` and `--remove-label` avoid replacing unrelated existing values.

For destructive operations, use the command-specific confirmation contract shown by `--help`:

```bash
linear issue delete ENG-123 --confirm
```

Do not treat `LINEAR_PROMPT_DISABLED=1` as authorization to mutate or delete Linear data.

## Command groups

| Group               | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| `linear auth`       | Authentication and workspace credentials                 |
| `linear issue`      | Query, inspect, create, update, start, and delete issues |
| `linear team`       | Teams, members, states, and repository autolinks         |
| `linear project`    | Project discovery and management                         |
| `linear milestone`  | Project milestone management                             |
| `linear document`   | Linear document workflows                                |
| `linear initiative` | Initiative discovery                                     |
| `linear cycle`      | Cycle discovery and issue filtering                      |
| `linear label`      | Workspace and team labels                                |
| `linear user`       | Workspace member discovery                               |
| `linear api`        | Execute an explicit Linear GraphQL operation             |
| `linear version`    | Inspect build identity and protocol capabilities         |

Discover the current command contract from the installed binary:

```bash
linear version --json
linear usage
linear --help
linear issue --help
linear issue query --help
```

Generated command documentation is available under [`.agents/skills/linear-cli/references`](.agents/skills/linear-cli/references/commands.md).

## Configuration

Configuration can be supplied through environment variables or `.linear.toml`. Environment variables take precedence.

| Setting                   | Environment variable              | TOML key                   |
| ------------------------- | --------------------------------- | -------------------------- |
| Default team              | `LINEAR_TEAM_ID`                  | `team_id`                  |
| Workspace slug            | `LINEAR_WORKSPACE`                | `workspace`                |
| Issue sorting             | `LINEAR_ISSUE_SORT`               | `issue_sort`               |
| Ask for project on create | `LINEAR_ISSUE_CREATE_ASK_PROJECT` | `issue_create_ask_project` |
| Default self-assignment   | `LINEAR_ISSUE_CREATE_ASSIGN_SELF` | `issue_create_assign_self` |
| Version control system    | `LINEAR_VCS`                      | `vcs`                      |
| Download inline images    | `LINEAR_DOWNLOAD_IMAGES`          | `download_images`          |

Prompting is controlled independently:

```bash
LINEAR_PROMPT_DISABLED=1
```

Configuration files are resolved in this order:

1. `./linear.toml` or `./.linear.toml`;
2. repository-root `linear.toml` or `.linear.toml`;
3. repository-root `.config/linear.toml`;
4. the platform user configuration directory.

## Attachments and public images

Attachments are private to the Linear workspace by default:

```bash
linear issue attach ENG-123 ./screenshot.png
linear issue comment add ENG-123 --attach ./screenshot.png
```

Passing `--public` uploads supported raster images to a public `public.linear.app` URL:

```bash
linear issue comment add ENG-123 \
  --attach ./screenshot.png \
  --public
```

Anyone with that URL can access the image without authenticating. The CLI therefore requires this behavior to be selected explicitly.

## Agent Skills

The repository uses the standard [Agent Skills](https://agentskills.io/) layout:

- [`.agents/skills/linear-cli`](.agents/skills/linear-cli/SKILL.md) teaches compatible agents this fork's commands and safety contracts.
- [`.agents/skills/releasing`](.agents/skills/releasing/SKILL.md) documents the contributor release workflow for this repository.

Compatible agents discover these Skills automatically when working in this checkout. To install only the Linear management Skill elsewhere with the cross-agent Skills CLI:

```bash
npx skills add jihuanshe/linear@linear-cli
```

Agents must use the installed `jihuanshe/linear` binary. They should not fall back to the upstream npm package because its available commands and automation contracts may differ from this fork.

## Development

This is a Deno project. `AGENTS.md` is the development contract, `deno.json` is the task source, and `mise.toml` pins the supported runtime.

```bash
git clone https://github.com/jihuanshe/linear
cd linear
mise install
```

Amp Orbs use `.agents/setup` and `.agents/resume` instead of the host's mise installation.

Run source verification during development:

```bash
deno task verify-source
```

That runs GraphQL code generation, formatting checks, linting, type checking, and all non-Keyring tests.

When the command tree, help output, or Skill template changes, regenerate the Linear CLI Skill:

```bash
deno task generate-skill-docs
```

Before a release, run the complete local release gate:

```bash
deno task verify-release
```

The [release Skill](.agents/skills/releasing/SKILL.md) is the release procedure. An authorized push to `main` starts [`Ship main`](.github/workflows/ship-main.yml), which runs Linux Keyring integration, builds five platforms, verifies and attests the assets, and publishes the GitHub Release. Source-controlled versions remain `0.0.0-dev`; published versions come from the commit timestamp and SHA.

## Upstream and credits

This repository is a downstream fork of [`schpet/linear-cli`](https://github.com/schpet/linear-cli).

The original project was created by Peter Schilling. Many features, command designs, tests, documentation sections, and integrations in this repository were created by the [upstream contributors](https://github.com/schpet/linear-cli/graphs/contributors).

The downstream changelog summarizes this fork's changes without copying the upstream release history. Exact rolling-build history remains available in this repository's Git history and GitHub Releases.

When reporting an issue:

- report fork-specific automation, release, JSON, or safety-contract problems to [`jihuanshe/linear`](https://github.com/jihuanshe/linear/issues);
- if a problem also reproduces in the unmodified upstream project, consider reporting it to [`schpet/linear-cli`](https://github.com/schpet/linear-cli/issues).

## License

Distributed under the ISC License.

Copyright (c) Peter Schilling and contributors.

See [LICENSE](LICENSE) for the full license text.
