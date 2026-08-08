# Agent interface architecture and delivery roadmap

Status: accepted architecture roadmap, revised after an independent design review. The progressive `usage` baseline, metadata hardening, and distribution/version/capability probe are implemented; zero-argument navigation is the next commit. The guide system and Skill migration are not yet implemented.

## Executive summary

The CLI should become a version-matched, progressively discoverable protocol for both humans and agents. Jihuanshe should expose one installed Linear Agent Skill for first-mile activation; the CLI should own the workflows currently split across the external Linear Skill family.

The ownership rule is:

> Linear command facts and reusable Linear workflows belong to the CLI. One external Skill activates Linear; authorization remains a host policy and never follows from CLI capability.

This leads to four layers:

```text
One external Linear Skill
  activation for every Linear task; missing-binary bootstrap only
        |
        v
CLI discovery
  root navigation, usage, domain usage, leaf --help
        |
        v
Embedded guides
  version-matched cross-command workflows and semantic warnings
        |
        v
Execution protocol
  typed commands, structured output, schema-assisted raw GraphQL fallback
```

The important change is not merely making one Skill shorter. It is removing competing external routes and moving reusable Linear behavior to the versioned program that owns it.

## Motivation

### The current first-run experience is a dead end

Running `linear` without arguments currently prints only:

```text
Use --help to see available commands
```

That misses an opportunity to teach progressive discovery, distinguish commands from workflows, and direct an agent to version-matched documentation.

### Generated Skill references duplicate the command tree

The current `linear-cli` Skill contains a generated command catalog and one generated reference per domain. Most of this material is a snapshot of information already owned by Cliffy's command tree: command names, aliases, arguments, options, defaults, and descriptions.

This duplication has three costs:

- documentation can drift from the installed binary;
- every Skill load can consume facts that are irrelevant to the current task;
- the generator and release gate must maintain a second representation of the command surface.

### A thin Skill alone is not enough

The useful pattern in tools such as `lark-cli` and `agent-browser` is not simply that their external Skill is short. Domain knowledge has moved into version-matched runtime resources, and the external Skill teaches the agent how and when to discover them.

Embedding guides solves versioning and cohesion, but it does not solve first-mile activation. An installed binary cannot tell an agent to use `linear` until the agent has already selected it. One small external Skill remains necessary for:

- recognizing every Linear task, URL, and identifier;
- invoking the CLI's own discovery and version-matched workflows when the exact command is not already known;
- bootstrapping the canonical binary when `linear` is absent.

Access repair, request intake, and protected batch writes are Linear product workflows, not reasons to install competing host Skills. They should become CLI commands and embedded guides. Authorization remains outside the CLI in the host's system or repository policy.

## Reference patterns

### Linearis

[Linearis](https://github.com/linearis-oss/linearis) demonstrates CLI-native two-level usage, centralized machine output, batch mutation input resolution, and client reliability policy. The parts worth adapting are the principle that the CLI is an on-demand protocol and that a Skill teaches discovery rather than copying every flag.

The parts not to copy are equally important: this CLI should not become JSON-only, weaken destructive-operation protection, silently ignore invalid field projections, retry mutations indiscriminately, or reduce the existing raw GraphQL escape hatch.

### Lark router Skill

The [`lark` router Skill](https://github.com/jihuanshe/skills/blob/main/skills-stable/lark/lark/SKILL.md) is short because detailed, version-coupled domain knowledge is read from `lark-cli skills list/read`. It still retains cross-Skill routing, execution-path priority, high-risk-write policy, and environment recovery. Its lesson is that knowledge moved to a better owner; it was not deleted.

### agent-browser

`agent-browser` combines a useful no-argument `Start here` section, version-matched embedded Skills, full leaf command help, and `skills path` for filesystem access. It shows that runtime guides and a materialized path can coexist: structured discovery serves portability while files preserve agent and Unix search affordances.

## Design principles

1. **One owner for command facts.** Command names, arguments, options, aliases, defaults, and runtime capabilities come from the live Cliffy tree.
2. **One owner for version-matched workflows.** Cross-command CLI handbooks live in this repository and ship with the binary.
3. **One Skill activates; the CLI teaches.** The external Skill has one positive route for all Linear work. Command selection, access diagnosis, issue intake, batch execution, and result semantics belong to CLI code, help, and embedded guides.
4. **Progressive disclosure is optional, not ceremonial.** An agent that already knows the exact dedicated command may call it directly. An uncertain agent must have a reliable path that does not require guessing.
5. **Machine mode never grants consent.** `writes: true`, JSON output, `LINEAR_PROMPT_DISABLED=1`, `--force`, `--confirm`, and `--yes` describe capabilities or execution mechanisms, not authorization.
6. **Dedicated commands precede escape hatches.** Prefer a purpose-built command, then schema-assisted `linear api`, and use direct HTTP only when the CLI cannot provide required control.
7. **Documentation aids safety; code enforces it.** Guides can explain label replacement, destructive operations, and document anchors, but runtime validation and confirmation remain the final guard.
8. **Searchability is an interface, not a storage accident.** Filesystem grep is useful, but agents should not need to know host-specific Skill installation paths.
9. **Remain offline and deterministic.** Guide discovery must not require network access, embeddings, or an external service.
10. **Add complexity only after evidence.** Start with a small guide corpus and `list`/`read`/`path`. Add internal search, richer ranking, or embedded specialist workflows only when evals show a need.
11. **Preserve intent, not templates.** Issue guidance should help an unfamiliar human or agent recover the goal, evidence, closure reason, and any next hop. It must not require ceremonial sections that add no information.
12. **Status is a routing signal, not proof.** A completed Issue tells an agent to re-check linked work; it does not prove that source, deployment, or a temporary compatibility path is ready to change.

## Design review decisions

An independent review of the phase-one baseline and this architecture accepted the four-layer ownership model and identified the following decisions for subsequent commits:

1. Supplemental command capability metadata must be co-located with each leaf command definition rather than added at parent registration sites. An exact writes-command completeness test must make omissions fail visibly.
2. Internal guide search is not part of the initial guide system. With four guides, `list`, `read`, and `path` plus filesystem tools are sufficient. Search is evidence-gated.
3. Static text imports are the preferred embedding mechanism. Deno 2.9.4 can embed `import ... with { type: "text" }` resources in cross-compiled binaries without a generated content module.
4. Single-command semantic facts belong in that command's description and help. Guides own genuinely cross-command workflows; the external activation Skill must not duplicate facts that help can expose before execution.
5. An exploratory current-family-versus-one-activation eval must run after zero-argument navigation and before guide authoring. Its failure cases become requirements for the first guide corpus. The formal migration comparison runs only after access diagnosis, intake, and typed batch workflows have CLI owners.
6. Local generated-reference removal is a separate review boundary from the final atomic `jihuanshe/skills` replacement.

These decisions narrow the first guide implementation and move empirical discovery earlier in the sequence.

## Knowledge ownership

### Content that belongs to the CLI command tree

- command and domain names;
- aliases;
- positional arguments and their types;
- options, defaults, static requirements, list and repeatable behavior;
- command descriptions;
- whether a command can write;
- whether it can prompt;
- the actual confirmation-bypass option, if any;
- supported output modes;
- the full reference for one leaf command.

This content should be exposed by `usage`, `usage --json`, and leaf `--help`, not copied into generated Skill references.

Some capability facts cannot be inferred mechanically from Cliffy's syntax. Their annotations must live in the same leaf module as the action they describe, so a contributor changing the command sees behavior and metadata together. A test must pin the exact canonical paths classified as writes. Parent domain wiring must not become a hidden capability registry.

### Content that belongs to embedded CLI guides

- how to discover commands progressively;
- stdout/stderr, JSON, exit status, and unattended automation contracts;
- dedicated command versus raw GraphQL selection;
- writing and verifying multi-step operations;
- clarifying a request, collecting evidence, and shaping one or more development-ready Issues before creation;
- Markdown file flags;
- complete-label-set replacement versus incremental label changes;
- writing Issues that survive handoff, use durable links, and end with a closure reason plus a clickable next hop when work continues;
- schema discovery, variables, pagination, and GraphQL fallback;
- batch plan/apply, conflict, checkpoint, and recovery semantics once batch execution is a first-class CLI feature.

These are product-owned and often version-dependent, but they span more than one command and do not fit in flag descriptions.

Facts that can be fully stated by one command must remain in that command's description instead. For example, `issue mine` being current-user scoped and `issue attach` creating a sidebar attachment should be discoverable directly from those commands' help. A guide may explain a broader querying or attachment workflow, but it must not be the sole or duplicate owner of the leaf fact.

### Content that remains outside the CLI

- whether a task should activate Linear tooling at all;
- explicit authorization and the host's external-write boundary;
- organization-specific installation and credential policy;
- environment routing such as macOS versus exe.dev;
- owner identity, Reflection, integration selection, and secret-handling policy;
- organization or host policy for linking source-local temporary behavior to an Issue and deciding whether creating that external object is authorized;
- availability and authorization of browsers, logs, repositories, conversations, or other host tools.

These policies already come from the host system prompt, repository guidance, and the current user task. They should not require separate Linear Skills. Embedded intake guidance may tell the agent what evidence a useful Issue needs, while the host decides which tools and writes are allowed.

### Current `jihuanshe/skills` Linear family

The current family should converge to one external activation Skill:

| Current Skill              | Migration target                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linear-cli`               | Rename or replace with the single external `linear` activation Skill. Remove its command manual after CLI discovery and embedded workflows pass evals.                                       |
| `linear-access`            | Move diagnosis, authentication, and repair into CLI commands and embedded guidance. Keep only the missing-binary bootstrap fact in the single activation Skill, then delete this Skill.      |
| `linear-request-intake`    | Move clarification, evidence quality, Issue decomposition, and authoring guidance into the CLI's Issue-creation workflow. Delete this Skill after the embedded workflow passes intake cases. |
| `linear-issue-batch-write` | Move plan/apply, conflict, checkpoint, and recovery into first-class typed CLI commands and an embedded guide. Delete this Skill after behavior and recovery evals pass.                     |

## Progressive command discovery

### Phase-one foundation

The phase-one baseline adds:

```bash
linear usage
linear usage --json
linear issue usage
linear issue usage --json
```

The documents are generated from the actual Cliffy command tree. Supplemental semantics use Cliffy's native metadata and include:

- `writes`;
- `interactive`;
- `confirmation`;
- `outputModes`.

The JSON contract currently has `schemaVersion: 1`. Hidden commands and options remain hidden, aliases resolve to canonical paths, and leaf detail continues through `--help`.

Measured phase-one output sizes provide an initial discovery budget:

| Invocation                  |  Bytes |
| --------------------------- | -----: |
| `linear usage`              |  1,247 |
| `linear usage --json`       | 12,010 |
| `linear issue usage`        |  9,973 |
| `linear issue usage --json` | 52,505 |

The concise root view is suitable as a default entry point. The issue-domain JSON is useful for structured tooling but too large to recommend as an unconditional first read; agents should progress to one domain or leaf only when needed.

Completed phase-one hardening:

- supplemental metadata annotations live in leaf command modules with their definitions and actions, not in parent wiring files;
- an exact completeness test, including hidden commands, pins all 43 canonical paths that can write persistent remote or user-configured local state. `issue view` is included because downloads can target the configured `attachment_dir`; transient cache writes and explicit exports are excluded;
- tests freeze the `Writes`, `Interactive`, `Confirmation required unless`, and `Output modes` Cliffy labels as well as the lowercase labels in human `usage` output;
- an omitted option `default` means either no static default representable in usage JSON v1 or a dynamic/non-serializable default, not necessarily that the runtime has no default;
- usage JSON v1 readers ignore additive fields. Schema version 1 remains valid for additions; removing or retyping an existing field requires an increment.

### Root navigation

Invoking `linear` without arguments should produce a concise navigation page rather than only directing the user to `--help`. It should remain small enough for default agent consumption.

Illustrative final-state output:

```text
linear — Work with Linear from the command line

Start here:
  linear usage                  Discover available domains
  linear issue usage            Discover issue commands and options
  linear issue create --help    Read one command's full reference
  linear guides                 List version-matched workflow guides
  linear guides read core       Read the automation and safety contract

Long-tail GraphQL:
  linear schema
  linear api --help

Commands:
  auth          Authentication and identities
  issue         Issues, comments, attachments, and relations
  project       Projects
  initiative    Initiatives
  ...
```

The root action should reuse the existing usage document rather than build another command catalog. The zero-argument navigation commit must initially mention only commands that exist at that point; `guides` entries are added only after the guide command ships.

### Domain navigation

Invoking an eligible command domain without a leaf, such as `linear issue`, should show the same progressive domain view as `linear issue usage`. This applies only to domains whose current no-argument action displays help. Commands such as `config`, whose no-argument action performs real work, are explicitly excluded. Domain output gains relevant guide summaries only after guides ship and must not print full guide bodies.

### Leaf reference

Leaf `--help` remains the precise command reference. Single-command semantics belong directly in the command description. A leaf may additionally gain a short `Related guides` section when genuinely cross-command workflow knowledge is relevant:

```text
Related guides:
  issue-writing
    Labels replace the complete set; use file flags for Markdown.
    Run: linear guides read issue-writing
```

The help entry is a breadcrumb, not an embedded copy of the guide.

### Contextual recovery

Selected validation errors may eventually link to one precise guide section when the failure is caused by non-obvious product semantics. This is deferred until guide-aware evals reveal concrete recovery failures; generic errors must not add guide noise.

Suitable cases include:

- replacing a complete label set;
- confusing sidebar and inline attachments;
- document anchor safety;
- batch conflict or recovery steps.

## Embedded guides

### Source layout

Canonical Markdown should live in this repository:

```text
docs/guides/
  core.md
  automation.md
  issue-writing.md
  graphql.md
  issue-batch.md        # added only with first-class batch commands
```

The first implementation should include only `core`, `automation`, `issue-writing`, and `graphql`. A small corpus lets us validate the interface before migrating every existing handbook.

### Metadata

Each guide should contain structured metadata, for example:

```yaml
---
name: issue-writing
title: Writing and updating issues
description: Durable handoff context, Markdown, labels, attachments, closure, and next hops
keywords:
  - issue
  - update
  - handoff
  - closure
  - next-hop
  - markdown
  - label
  - attachment
  - 标签
  - 附件
commands:
  - issue create
  - issue update
  - issue comment add
  - issue attach
seeAlso:
  - automation
---
```

Guide metadata, rather than command registration, owns command-to-guide relationships. The build derives a reverse index and validates that every canonical command and `seeAlso` guide exists. This avoids a second hand-maintained command-to-guide registry.

### Build-time embedding

Markdown remains human-readable and grep-friendly in the repository. The release build embeds it into the compiled binary so installed documentation always matches the installed CLI version.

Use Deno's stable static text imports as the first implementation:

```ts
import core from "../../docs/guides/core.md" with { type: "text" }
```

Deno 2.9.4 embeds statically analyzable text imports in the module graph used by `deno compile`, including cross-compilation. A small explicit import manifest is acceptable as a build manifest, but tests must compare it with `docs/guides/*.md` so a new guide cannot be silently omitted. The Markdown remains the sole content source.

Before relying on this mechanism, verify `deno check`, lint, Markdown formatting, the repository's publication/type checks, and a compiled-binary guide-read smoke test. If text imports conflict with those paths, fall back to a generated TypeScript resource module with a real source-to-generated byte-equality check.

The guide system does not export an Agent Skill, create host frontmatter, or recreate command references.

## Guide CLI

### Required commands

```bash
linear guides
linear guides list
linear guides list --json
linear guides read <name>
linear guides path
```

`linear guides` should be an alias for the concise list view.

An explicit export command may be added after the cache-backed path behavior is proven:

```bash
linear guides export <directory>
```

### Output contracts

- `guides list` writes a concise human index to stdout.
- `guides list --json` preserves stable names, descriptions, keywords, and related canonical command paths.
- `guides read` writes only the selected Markdown body to stdout.
- `guides path` writes only one absolute directory path to stdout so it composes with shell tools.
- informational materialization messages, if any, go to stderr.
- no guide command requires authentication or network access.

### Filesystem materialization

`linear guides path` should lazily materialize the embedded Markdown into a versioned user cache and print that directory:

```bash
GUIDES="$(linear guides path)"
rg -n "inline|attachment|image" "$GUIDES"
```

The cache should use the operating system's standard cache directory and include the CLI version, for example:

```text
<cache>/linear/guides/<version>/
  core.md
  automation.md
  issue-writing.md
  graphql.md
  manifest.json
```

Materialization requirements:

- embedded names cannot create nested or traversing paths;
- files are written atomically;
- a manifest records CLI version and content checksums;
- an intact cache is reused;
- a mismatched or partial cache is rebuilt safely;
- the current working directory is never modified by default;
- guide contents contain no credentials or workspace data.

`guides export <directory>`, if added, should refuse to overwrite unrelated content by default and require an explicit overwrite option. It is a byte-for-byte resource projection, not a Skill-generation system.

### Why a materialized path is part of the initial interface

Filesystem materialization preserves a strong Unix and agent affordance: agents can use `rg`, `fd`, `sed`, and `cat` without knowing a host-specific Skill installation directory. With the initial four-guide corpus, the concise structured list plus a materialized path covers both overview and full-text discovery without introducing a search engine.

Internal search remains a possible portability feature for environments without `rg`, but it must be justified by observed retrieval failures rather than assumed upfront.

## Deferred search design

The initial guide system does not implement `guides search`. The exploratory and formal evals should record whether `guides list`, command breadcrumbs, direct reads, and `guides path` plus filesystem tools fail to retrieve relevant knowledge. Add internal search only if those failures are material or a named consumer cannot rely on filesystem tools.

If internal search becomes justified, begin with deterministic, weighted lexical matching over guide sections:

| Match                 | Relative priority |
| --------------------- | ----------------: |
| exact guide name      |           highest |
| title exact or prefix |              high |
| keyword               |              high |
| related command path  |       medium-high |
| section heading       |            medium |
| body substring/token  |            normal |

The index unit should be a Markdown section, not an entire guide, so results can point to `issue-writing > Replacing labels` rather than only `issue-writing`.

Normalize ASCII case and punctuation. For Chinese and mixed-language queries, retain whole-substring matching, index CJK bigrams, and allow a small set of curated bilingual keywords in guide metadata. `Intl.Segmenter` may supplement this if its behavior is deterministic in supported builds.

### Possible later BM25 upgrade

BM25 is reasonable once the corpus grows enough that basic ranking produces ambiguous results. It should remain an offline section-level index and may add boosts for title, keyword, and related-command matches.

Do not begin with embeddings, a vector database, an external service, or network-dependent semantic search.

## Guide discoverability in command metadata

The reverse index derived from guide frontmatter should feed every discovery surface:

- root navigation lists the core guide entry point;
- domain usage lists directly relevant guides;
- leaf help lists one or two related guides;
- `usage --json` includes concise guide metadata;
- `guides list/read/path` use the same embedded corpus and index.

Illustrative `usage --json` extension:

```json
{
  "name": "update",
  "path": "linear issue update",
  "writes": true,
  "interactive": true,
  "confirmation": null,
  "outputModes": ["human"],
  "guides": [
    {
      "name": "issue-writing",
      "description": "Markdown, labels, assignees, and safe update behavior"
    },
    {
      "name": "automation",
      "description": "Unattended execution and write verification"
    }
  ]
}
```

Usage JSON follows a tolerant-reader policy: unknown additive fields may appear within a schema version. Adding `guides` therefore retains `schemaVersion: 1`; removing or retyping an existing field requires an increment. Tests must assert that all existing v1 fields remain unchanged when guide metadata appears.

## Single external Skill

The eventual installed external Skill should be named `linear` and cover the complete positive activation space: Linear URLs and identifiers, workspace reads and writes, authentication and installation trouble, request-to-Issue intake, and batch operations. It should retain only:

- positive and negative activation boundaries;
- one instruction to use the installed `linear` CLI and follow its contextual discovery;
- the canonical missing-binary bootstrap route, because an absent program cannot describe its own installation.

It should not contain:

- the complete command catalog;
- one static reference file per domain;
- copied flags, aliases, defaults, or argument types;
- a GraphQL schema snapshot;
- access, intake, batch, or issue-writing handbooks;
- a requirement to run version, usage, or guide discovery before every known operation;
- authorization policy already supplied by the host and current task.

The Skill exists to make the agent select `linear`, not to supervise the CLI. An agent that knows the exact command calls it directly. Root navigation, command help, validation errors, and related-guide breadcrumbs provide discovery only when needed.

### Bootstrap and version convergence

The future `jihuanshe/skills` rewrite must retain a missing-binary bootstrap route. Compatibility checks belong to CLI startup, diagnostics, and self-update code rather than a mandatory preflight in the external Skill.

The existing conventional version probe is:

```bash
linear -V
```

A plain version string does not prove distribution identity or installation ownership. The stable, read-only machine probe is:

```bash
linear version --json
```

with this v1 contract:

```json
{
  "schemaVersion": 1,
  "distribution": "jihuanshe/linear",
  "version": "0.0.1780000000-gabcdef0",
  "capabilities": ["usage-v1"]
}
```

Version JSON v1 is additive. Readers require `schemaVersion: 1`, the exact `jihuanshe/linear` distribution, and every capability needed for their integration; they ignore unknown fields and capability identifiers. The initial capability vocabulary is `usage-v1`. CLI diagnostics should report missing or incompatible capabilities without asking the external Skill to classify a second Linear route.

The probe identifies the build, not the package manager. Installation ownership still requires evidence from `mise which linear`, `type -a linear`, the resolved executable path, or the organization manager.

The bootstrap and diagnostic flow must distinguish five cases:

| State                                                                                    | Action                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compatible `jihuanshe/linear` with required capabilities                                 | Execute the requested command directly. Use version-matched discovery only when needed; do not perform a network update on every task.                                                                                                                              |
| Compatible fork that the user or policy explicitly wants updated                         | Use `linear update`; a mise-managed binary performs a tool-scoped `mise up`, while a standalone release verifies checksums before replacement. Uninstall is unnecessary.                                                                                            |
| Missing binary                                                                           | The single external Skill uses the canonical organization bootstrap route, then returns to the CLI.                                                                                                                                                                 |
| Shell-resolved foreign or conflicting binary with a diagnostic-capable canonical binary  | Invoke diagnostics through the canonical manager-resolved Jihuanshe binary, not the conflicting shell-resolved executable. Diagnostics report observed identities and a safe next action; host authorization still governs removal or global configuration changes. |
| No canonical binary, or the canonical binary lacks required diagnostic/update capability | Use the authorized mise or Rotom bootstrap/update path first, then invoke diagnostics through the resulting canonical binary. Never ask the foreign binary to implement Jihuanshe diagnostics.                                                                      |

For supported unmanaged machines, the canonical install command from this repository is:

```bash
mise use -g "github:jihuanshe/linear[minimum_release_age=0s]@latest"
```

Verification must use the mise-selected binary and then the shell-resolved binary:

```bash
mise which linear
"$(mise which linear)" version --json
command -v linear
linear version --json
linear usage
```

If another installation shadows mise, invoke the future diagnostic command through `"$(mise which linear)"` so the known Jihuanshe binary compares itself with the shell-resolved executable. If no canonical binary is available, or that binary is too old to diagnose or update safely, use the authorized bootstrap/update path before diagnosis. npm, Homebrew, Deno, and manually copied binaries have different removal procedures; no generic `rm` or guessed `npm uninstall` command is safe. Removing a manually installed or otherwise unknown executable is destructive and requires explicit user authorization.

On Jihuanshe-managed machines, the current authoritative policy is different: Rotom owns the managed mise configuration. The safe probes and convergence path are:

```bash
rotom status --format json
rotom inspect latest --format json
rotom setup
```

The external Skill must not bypass Rotom with a direct global `mise use` unless the organization intentionally changes that policy in its host guidance and Rotom documentation. A future decision to standardize all hosts on direct mise is a coordinated organization-policy migration, not an incidental Linear documentation edit.

Checking compatibility is read-only. Uninstalling another distribution or writing global mise configuration is not implied by an ordinary Linear read task; the host authorization boundary still applies.

### Why one activation Skill remains external

The one external Skill solves first-mile activation. The CLI owns Linear-product behavior after selection; host system, repository, and user policy continue to own authorization and cross-tool availability. Embedded content cannot activate a binary the agent has not considered, but this limitation requires one broad loading description, not separate Skills for each Linear workflow.

No complex Skill export is required. The external Skill points at `linear`; the program's root navigation, command help, and contextual breadcrumbs expose stable discovery entry points without the host artifact mirroring or orchestrating them.

## Generated documentation migration

The current `generate-skill-docs` pipeline should not be removed until the replacement passes evals. After migration, its responsibility should change from generating a complete static manual to validating the discovery contract.

Candidate validations include:

- guide frontmatter parses and names are unique;
- every related canonical command exists in the Cliffy tree;
- every `seeAlso` guide exists;
- every command domain exposes progressive usage;
- writes and confirmation metadata remain complete;
- embedded Markdown matches the source byte-for-byte;
- the single activation Skill only references real, stable entry points;
- release artifacts can list and read embedded guides without source files present.

The generated command catalog and per-domain Skill references can then be deleted. Existing curated material should first be classified and migrated to the command tree, an embedded guide, the single activation Skill's missing-binary route, or host policy; it must not be discarded solely to reduce bytes.

## Evaluation strategy

### Early exploratory comparison

After zero-argument navigation lands and before guide content is authored, compare:

- the current external Skill family;
- one temporary `linear` Skill containing only the complete activation boundary and missing-binary bootstrap.

Both conditions receive identical host authorization and cross-tool policy. This run is exploratory. It must use new condition names and must not overwrite or reinterpret the existing frozen experiment artifacts. Its purpose is to identify which tasks fail without static recipes and sibling routes. Classify each failure as a CLI command/help gap, an embedded-guide requirement, a missing-binary bootstrap gap, or a host-policy gap.

The exploratory comparison is not evidence that the final migration is safe because embedded guides do not exist yet and one model/effort configuration is not representative enough for that claim.

### Formal migration comparison

After access diagnosis, intake, and typed batch workflows have CLI owners, run two conditions against the same CLI build, model configuration, and host policy:

| Variant           | Content                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| A: current family | The current external Linear Skills, generated catalog, references, recipes, and released CLI.               |
| B: one activation | One external `linear` Skill plus the released CLI's commands, contextual discovery, and embedded workflows. |

Variant B is the fixed architecture target, but the migration still fails if it regresses task success or safety. Repair failures in CLI code, command descriptions, embedded guides, the missing-binary bootstrap, or host policy rather than growing the activation Skill into another handbook.

### Primary gates

- supported task full success does not regress;
- holdout task success does not regress;
- GraphQL controls continue to choose `linear api` when appropriate;
- direct CLI routes do not fall back to raw GraphQL or HTTP unnecessarily;
- destructive operations do not infer consent from machine mode or bypass flags;
- fixtures and user content remain intact.

### Efficiency metrics

- installed Skill bytes;
- discovery invocations before the target command;
- discovery stdout and stderr bytes before the target command;
- total meaningful invocations;
- direct route versus recovery route;
- task duration where model/runtime variance permits a useful comparison.

The phase-one shim already records per-invocation stdout and stderr bytes and the grader reports discovery cost before the first target command.

Before any guide-aware condition runs, both the shim passthrough and grader discovery classifier must recognize `guides list`, `guides read`, and `guides path`. Otherwise guide use will fail closed or be counted as a meaningful task invocation, biasing comparisons against thin variants.

### Required behavioral cases

- current-user issue listing versus organization-scoped query;
- inline image versus sidebar attachment;
- multi-line Markdown via file flags;
- complete label replacement versus incremental changes;
- dedicated command versus GraphQL fallback;
- a legitimate raw GraphQL control;
- destructive confirmation;
- prompt-disabled execution without inferred consent;
- direct execution of an exact known command with no mandatory version, usage, or guide preflight;
- missing-binary bootstrap through the canonical organization path;
- PATH shadowing diagnosed through a manager-resolved canonical binary without invoking the foreign binary for Jihuanshe diagnostics;
- installed-binary authentication or access repair;
- ambiguous request intake that produces one or more reviewable Issue specifications before creation;
- typed batch plan/apply, conflict, checkpoint, and recovery behavior;
- creating an Issue that can be understood without the originating chat and links durable source evidence;
- closing an Issue with a clear reason and a clickable next hop when related work remains;
- an uncommon domain requiring progressive discovery;
- mixed Chinese and English guide discovery through names, descriptions, and keywords;
- guide filesystem search through `guides path`.

The formal corpus includes every behavioral case added by commit 8a and the first-class batch milestone. Access, intake, batch, and zero-preflight cases each have a predeclared per-case floor; aggregate supported-task success cannot hide a regression in a deleted Skill's former route.

### Interpretation

The goal is not to minimize Skill bytes in isolation. The migration succeeds only if safety and task success remain at least as strong while default context and static documentation drift decrease.

Three trials per case have limited statistical power. Formal comparison rules must predeclare per-case floors and control requirements, treat per-case counts as co-primary evidence, and avoid interpreting a non-significant Fisher result as equivalence.

## Implementation TODO

This repository ships through direct commits to `main`; pushing a commit invokes the rolling `Ship main` workflow. The sequence below denotes independently reviewable commits, not GitHub pull requests. Each Orb should start from the latest `main`, own one unchecked item, run that item's gate, and avoid combining independent items merely to reduce commit count.

- [x] Establish the phase-one baseline: progressive usage, command capability metadata, discovery byte accounting, generated-reference alignment, and this architecture document.
- [x] Commit 1 — harden and finalize progressive usage metadata.
- [x] Commit 2 — add a stable distribution/version/capability probe.
- [ ] Commit 3 — improve root and eligible-domain zero-argument navigation.
- [ ] Commit 4 — run and document the exploratory current-family-versus-one-activation eval.
- [ ] Commit 5 — embed the minimal evidence-driven guide corpus and add `guides list/read`.
- [ ] Commit 6 — derive guide breadcrumbs for domain usage, leaf help, and usage JSON.
- [ ] Commit 7 — add safe, cache-backed `guides path` materialization.
- [ ] Commit 8a — move installed-binary access diagnosis and request intake to CLI-owned workflows.
- [ ] Commit 8b — remove the local generated manual and convert generation into contract validation.
- [ ] Commit 9 — add unified opt-in machine output.
- [ ] Commit 10 — batch-resolve non-interactive issue mutation inputs.
- [ ] Commit 11 — add conservative timeout, rate-limit, and query retry behavior.
- [ ] Evidence-gated later work — add machine-output field projection only if measured output cost justifies it.
- [ ] Later — move protected batch issue execution into first-class typed CLI commands before embedding its complete handbook.
- [ ] Final migration — run the formal comparison, replace the external Linear Skill family with one activation Skill, and remove the superseded Skills atomically.

## Proposed commit sequence

Each commit should preserve a single reviewable and independently verifiable behavior boundary. The numbering names review boundaries; it does not force all work into one dependency chain.

Two workstreams may proceed after commit 1 hardens the shared metadata and eval foundation:

| Workstream              | Commits | Dependency                                                                                                                                                        |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery and knowledge | 2–8b    | Version probing, navigation, exploratory evals, embedded guides, access/intake ownership, and generated-manual removal build on each other in order.              |
| Execution protocol      | 9–11    | Independent of guide migration. Commit 9 fixes machine-error projection; commit 11 may develop transport policy in parallel but integrates against that contract. |

Field projection remains an optimization backlog rather than a promised phase. Architecture constraints graduate into `AGENTS.md` with the commit that proves them; this roadmap must not describe an aspirational command/resolver/service split as an already-enforced repository invariant.

### Commit 1: harden and finalize progressive usage

Scope:

- current `usage` implementation and tests;
- command capability metadata co-located in leaf command modules;
- an exact canonical writes-command completeness test;
- the additive usage JSON policy and static-versus-dynamic default semantics;
- frozen human metadata labels rendered by Cliffy;
- generated reference alignment required by the new metadata;
- discovery invocation and byte-cost instrumentation.

Non-goals:

- no guide system;
- no Skill deletion;
- no machine-output redesign;
- no command execution behavior changes.

Gate:

- targeted usage/eval tests;
- complete source verification;
- generated Skill output proven current.

### Commit 2: add a stable distribution and version probe

Scope:

- add a read-only human and JSON version command;
- expose stable distribution identity, release version, and additive capability identifiers;
- keep installation-manager detection out of the build identity contract;
- document how CLI diagnostics expose an incompatible or capability-incomplete build and how the single external Skill bootstraps an absent binary.

Non-goals:

- no network request to determine latest on every invocation;
- no automatic update, uninstall, or global mise mutation;
- no inference that a version check grants repair authorization.

Gate:

- development and release build outputs are deterministic;
- JSON follows an additive schema policy;
- the probe works without authentication or network access;
- tests distinguish build identity from `mise which linear` installation ownership.

### Commit 3: improve zero-argument and domain navigation

Scope:

- make `linear` show concise progressive navigation using the existing usage model;
- make only domains whose current action calls `showHelp()` display their domain usage with no leaf;
- improve unknown-command guidance where Cliffy permits targeted suggestions;
- snapshot human output and measure bytes.

Non-goals:

- no embedded guides yet;
- no references to guide commands that do not exist yet;
- no full root `--help` dump;
- no output protocol changes.

Gate:

- root output remains within an explicit byte budget;
- command actions are never invoked accidentally while rendering navigation;
- aliases and global options remain correct.

### Commit 4: run the exploratory current-family-versus-one-activation eval

Scope:

- create a temporary single `linear` activation Skill with no access, intake, or batch sibling routes;
- run the existing task corpus with new exploratory condition names;
- document which tasks lose route accuracy, correctness, or safety;
- classify each failure as a CLI command/help gap, embedded-guide requirement, missing-binary bootstrap gap, or host-policy gap.

Non-goals:

- no final migration claim;
- no changes to frozen experiment-one or experiment-two artifacts;
- no guide authoring before findings are classified.

Gate:

- findings list exact failing cases and observed discovery paths;
- guide topics in the next commit are traceable to observed needs or already-established cross-command contracts.

### Commit 5: introduce the embedded guide foundation

Scope:

- add the minimal source guides justified by commit 4, expected to begin with `core`, `automation`, `issue-writing`, and `graphql`;
- make `issue-writing` teach request clarification, evidence quality, Issue decomposition, durable handoff context, closure reasons, and next hops without imposing a rigid universal template;
- define and validate guide metadata;
- embed Markdown with static text imports and a complete import manifest;
- add `guides list`, `guides list --json`, and `guides read`;
- update the eval shim and discovery classifier for the new guide commands;
- verify compiled binaries can read guides without repository files.

Non-goals:

- no search ranking;
- no materialized path;
- no Skill deletion;
- no batch migration.

Gate:

- text-import support passes check, lint, formatting, and publication/type diagnostics;
- the static import manifest contains every source guide exactly once;
- guide metadata and canonical command validation;
- deterministic human and JSON snapshots;
- a compiled Linux release binary can list and read a guide;
- the first guide-bearing release records manual macOS and Windows smoke evidence, because the current cross-compile workflow cannot execute those binaries on its Linux runner.

### Commit 6: add guide breadcrumbs to discovery surfaces

Scope:

- derive command-to-guide relationships from guide metadata;
- show concise related-guide entries in domain usage and leaf help;
- expose guide summaries in usage JSON;

Non-goals:

- no full guide bodies in help;
- no manually maintained command-to-guide registry.
- no contextual error links until eval evidence identifies a recovery gap.

Gate:

- every relationship points to a canonical command;
- hidden commands and guides remain hidden where intended;
- help output growth remains bounded;
- usage schema compatibility is explicitly tested.

### Commit 7: add filesystem materialization

Scope:

- cache-backed `guides path` with manifest, checksums, and atomic writes;
- validate materialized files against the embedded manifest.

Non-goals:

- no internal search;
- no BM25, tokenization, embeddings, or external search service;
- no explicit export command without a named consumer.

Gate:

- path traversal and partial-cache tests;
- concurrent invocation behavior;
- no cwd writes;
- cache reuse and safe rebuild tests;
- guide path and filesystem-search eval cases.

### Commit 8a: move access diagnosis and request intake into CLI ownership

Scope:

- inventory the accepted cases currently owned by `linear-access` and `linear-request-intake`;
- expose installed-binary authentication and environment diagnosis through CLI commands, command help, and embedded guidance;
- move request clarification, evidence quality, Issue decomposition, and durable Issue writing into the CLI-owned Issue-creation workflow;
- keep missing-binary bootstrap and host authorization outside the CLI;
- add behavioral cases for access recovery and request intake without loading sibling external Skills.

Gate:

- every accepted access and intake case has a CLI or host-policy owner;
- fresh agents recover installed-binary access failures through CLI discovery;
- fresh agents turn ambiguous requests into reviewable Issue specifications through the Issue-creation workflow;
- no diagnostic or machine capability is interpreted as authorization to mutate local or remote state.

### Commit 8b: remove the local generated manual

Scope:

- delete the generated command catalog and per-domain references whose CLI or host-policy owners were established by commits 4–8a;
- convert `generate-skill-docs` into discovery, metadata, guide, and single-activation-Skill contract validation;
- retain only content with an explicit local owner.

Gate:

- generated-reference removal does not regress the exploratory task cases or guide-aware routing;
- release verification checks the replacement contracts;
- a content migration ledger accounts for every removed curated section.

### Commit 9: unified opt-in machine output

Scope:

- add an explicit global JSON output context while preserving current human output as the default;
- migrate commands that already support `--json` first and keep their command-level flags compatible;
- return a stable `UNSUPPORTED_OUTPUT` error on unmigrated command paths rather than mixing human text into requested machine output;
- make successful machine-mode stdout contain exactly one payload and no banner, spinner, pager, progress, ANSI decoration, warning, or trailing prose;
- make failed machine-mode stdout empty and stderr contain exactly one structured error document with a stable code, message, optional suggestion, and retry metadata only when known;
- begin with `VALIDATION_ERROR`, `NOT_FOUND`, `AUTH_REQUIRED`, `UNSUPPORTED_OUTPUT`, `RATE_LIMITED`, `NETWORK_ERROR`, `API_ERROR`, and `INTERNAL_ERROR` codes backed by the existing `CliError` boundary;
- preserve GraphQL field names, nesting, connection shape, and command-specific payload semantics instead of wrapping successful data in a new generic envelope;
- decide with explicit tests whether JSON is compact by default, whether a separate compact option remains useful, and whether an inherited `LINEAR_OUTPUT` environment variable is safe enough to support;
- define whether help, usage, and version discovery participate in the global output context or retain their own explicit machine flags;
- keep machine output, prompt suppression, confirmation-bypass flags, authentication, and user authorization as independent contracts.

Non-goals:

- no implication that machine mode authorizes a write;
- no simultaneous migration of every command without a per-command payload contract;
- no field projection;
- no change to raw GraphQL response naming or pagination shape.

Gate:

- existing command-level JSON tests remain compatible;
- cross-command subprocess tests separately capture stdout, stderr, exit status, and terminal decoration;
- every machine-mode success parses as exactly one JSON value with empty stderr;
- every machine-mode failure has empty stdout, one parseable error document on stderr, and a nonzero exit status;
- unsupported command paths fail explicitly rather than falling back to human output.

### Commit 10: non-interactive issue mutation resolver

Scope:

- define one non-interactive resolution policy shared by explicit non-interactive options and prompt-disabled execution without treating prompt suppression itself as a performance contract;
- batch-resolve team, state, assignee, labels, project, milestone, cycle, and parent inputs for non-interactive create and update;
- let create and update use small operation-specific resolvers rather than requiring one generic resolver abstraction;
- preserve UUID passthrough, name/key/identifier matching, ambiguity, not-found, team/workspace scope, and current candidate-selection semantics;
- keep interactive candidate selection and its incremental lookups unchanged;
- fetch the target issue and necessary update context before resolving dependent update inputs;
- reduce nominal non-interactive lookup traffic to a fixed one or two GraphQL requests before the mutation.

Non-goals:

- no behavior change to interactive resolution;
- no weaker ambiguity or scope validation to achieve a lower request count;
- no retry policy bundled into resolver work;
- no repository-wide resolver/service rewrite.

Gate:

- request-count tests distinguish CLI invocations, nominal GraphQL requests, pagination, and retries;
- create and update tests lock the fixed lookup bound independently;
- regression tests cover every existing resolution semantic and prove invalid input fails before mutation;
- the production command path, not a test-only reimplementation, performs the measured resolution.

### Commit 11: conservative network reliability

Scope:

- add an abortable per-attempt timeout and an overall deadline that explicitly defines whether server-requested `Retry-After` waits count against it;
- parse both delta-seconds and HTTP-date `Retry-After` forms, subject to a bounded client policy;
- use exponential backoff with jitter for retryable query failures;
- retry queries only for `429`, `502`, `503`, `504`, and narrowly classified transient network failures by default;
- classify relevant HTTP 200 GraphQL error codes without treating authentication, permission, validation, or domain errors as transient;
- never automatically retry a mutation unless that operation separately proves idempotency or supplies a supported idempotency key;
- preserve the unknown outcome of a timed-out mutation instead of reporting that it definitely failed;
- expose retryability, HTTP status, server delay, attempt count, and partial-outcome information through the structured error boundary when available.

Non-goals:

- no GraphQL text heuristics that can misclassify an operation as a query;
- no blanket retry wrapper around `client.request`;
- no silent delay beyond the documented overall deadline;
- no special-casing tests by making production retry behavior deterministic.

Gate:

- fake-transport or local-server tests control the clock, sleep, and jitter deterministically;
- tests cover both `Retry-After` forms, deadline exhaustion, cancellation, and GraphQL error classification;
- nominal request-count tests remain separate from retry-attempt tests;
- tests prove transient queries retry and mutations do not duplicate after HTTP failures, network errors, or timeout ambiguity.

### Evidence-gated later work: machine-output field projection

Consider built-in projection only after machine payload schemas and measured output costs are stable. Its purpose is reducing CLI-to-agent output, not reducing GraphQL requests or server response size; `jq` and precise `linear api` selections remain valid alternatives.

If eval evidence justifies implementation:

- support nested objects, arrays, and connections without flattening or renaming fields;
- preserve `nodes`, `pageInfo`, and arbitrary `linear api` payload nesting;
- fail on every requested path that does not exist rather than silently accepting partial typos;
- test projection and compact formatting independently;
- demonstrate a material discovery or execution-output byte reduction on representative cases.

### Architecture constraints graduate with implementation

Update repository guidance alongside the commit that makes a boundary true and testable. Machine-output purity belongs with commit 9, resolver semantics with commit 10, and retry/idempotency rules with commit 11. A command/resolver/service layering rule, including any claim that services accept only UUIDs, applies only to migrated modules whose code and tests enforce it; it must not be declared globally in advance.

### Later: first-class batch issue execution

Move the existing protected batch-write workflow into typed CLI commands before embedding its complete operational handbook. Do not ship a guide that still requires locating an implementation script in a separately installed Skill.

Keep commits 9–11 independently reviewable from guide work and from one another. Commit 11 may develop transport behavior before commit 9 lands, but its machine-error projection must integrate after, or against a separately fixed version of, commit 9's structured error contract.

### Final migration: converge to one external Linear Skill

This stage starts only after installed-binary access diagnosis, request intake, and first-class typed batch execution have CLI owners.

Scope:

- run the formal current-family-versus-one-activation comparison;
- update `jihuanshe/skills` in its own repository and review;
- add one `linear` Skill whose description activates for the complete Linear task space;
- retain only the canonical missing-binary bootstrap route and one instruction to use the CLI's contextual discovery;
- remove `linear-cli`, `linear-access`, `linear-request-intake`, and `linear-issue-batch-write` in the same reviewed migration;
- verify no other external Skill still claims a Linear-only positive route.

Gate:

- fresh agents select the one external Skill for direct CRUD, installation/authentication trouble, request intake, and batch work;
- ordinary non-Linear tasks do not select it;
- exact known commands do not pay a mandatory version, usage, or guide preflight;
- uncertain agents recover through CLI root navigation, command help, errors, and embedded-guide breadcrumbs;
- no unknown binary is deleted through a guessed package name or direct `rm`;
- a managed Jihuanshe host does not bypass Rotom unless the organization policy is changed explicitly;
- every removed external Skill case has an explicit CLI command, embedded guide, missing-binary bootstrap, or host-policy owner;
- supported, holdout, GraphQL control, and safety requirements pass without growing the activation Skill into a handbook.

## Alternatives considered

### Keep the current generated Skill manual

Rejected as the long-term design because it duplicates live command facts, consumes context eagerly, and can drift from the installed version. It remains the migration baseline until evals prove the replacement.

### Remove every external Linear Skill

Rejected because embedded resources cannot provide first-mile activation before the agent has selected the binary. This requires exactly one broad external Linear Skill, not a family partitioned by workflow.

### Add `linear skills list/read`

Deferred. The initial guide corpus is small, and calling product handbooks `guides` distinguishes version-matched runtime resources from the one external activation Skill. A specialist embedded-Skill system can be reconsidered if the guide corpus grows beyond a simple handbook model.

### Depend on host Skill-directory grep

Rejected as the primary contract because Skill locations differ across hosts and static Skill contents can differ from the installed binary. `guides path` provides a supported, version-matched location while preserving the filesystem affordance.

### Add internal search immediately

Deferred because four guides can be listed concisely, read directly, and searched after `guides path`. Internal search becomes justified when evals show retrieval failures or a named environment lacks usable filesystem tools.

### Use BM25 immediately

Deferred until the corpus or evals first justify internal search and then demonstrate that metadata-aware lexical matching is insufficient.

### Export a complete Agent Skill from the binary

Rejected. It would recreate the duplicate manual and host-format coupling this design removes. Materializing embedded Markdown is intentionally not Skill export.

## Open decisions

The implementation commits must resolve these with tests or measured evidence:

1. Whether `guides` or singular `guide` best matches the existing command naming style.
2. The exact zero-argument navigation content and byte budget.
3. Whether static text imports pass every publication and release diagnostic; the fallback is a generated resource module.
4. The cross-platform cache directory, checksum manifest, and safest concurrent materialization algorithm.
5. Whether a cache-backed `guides path` is sufficient or an explicit `guides export` has a named consumer.
6. Which contextual errors benefit from a guide link after guide-aware evals, without making errors noisy.
7. Which intake cases require new CLI commands versus additions to the embedded Issue-writing workflow.
8. Which access failures require a new `doctor` or repair command, while keeping missing-binary bootstrap in the external Skill.
9. Whether Jihuanshe-managed hosts remain Rotom-owned or intentionally migrate to direct mise; this must be decided with the Rotom contract, not only in this repository.
10. Whether the existing external Skill release process needs synchronization beyond the single activation Skill.
11. Whether retrieval evidence ever justifies internal search; only then decide lexical tokenization, bilingual indexing, or BM25.

## Definition of done

The architecture is complete when:

- invoking `linear` teaches progressive discovery;
- one external Skill reliably activates every Linear task without partitioning access, intake, or batch work into sibling Skills;
- missing-binary bootstrap remains available, while installed-binary diagnosis and repair are CLI-owned;
- command facts come only from the live command tree;
- installed users can list, read, and materialize version-matched guides offline;
- related guides are discoverable from domain and leaf help without bloating output;
- exact known commands run directly, while uncertain agents can dynamically load only the relevant CLI-owned workflow;
- organization and cross-tool policy remains outside generic CLI behavior;
- issue-writing guidance preserves intent across handoffs and makes closure and continuing work unambiguous;
- the generated static command manual and per-domain references are removed;
- evals show no task-success, GraphQL-control, or safety regression;
- machine output, resolver performance, and retry work can proceed independently on the resulting foundation.
