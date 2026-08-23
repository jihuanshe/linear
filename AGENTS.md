# Repository Workflow

## Sources of truth

| Concern                              | Source                                      |
| ------------------------------------ | ------------------------------------------- |
| Runtime version and developer tasks  | `mise.toml`, `deno.json`                    |
| Orb bootstrap and source wrapper     | `.agents/setup`, `.agents/resume`           |
| Linear GraphQL schema and generation | `graphql/schema.graphql`, `codegen.ts`      |
| Production code and mirrored tests   | `src/`, `test/`                             |
| Deno permission changes              | `docs/deno-permissions.md`                  |
| Embedded workflow guides             | `docs/guides/`, `src/guides/`               |
| Release procedure                    | `.agents/skills/releasing/SKILL.md`         |
| Pull request source verification     | `.github/workflows/verify-pull-request.yml` |
| CI release implementation            | `.github/workflows/ship-main.yml`           |

`AGENTS.md` is the repository guidance source. `CLAUDE.md` is only a compatibility pointer to this file.

## Development loop

1. Use Deno `2.9.4`. In an Orb, lifecycle scripts provision the dedicated primary checkout at `$HOME/workspace/repo` and publish its `deno` and source-backed `linear` commands through Orb-owned `~/.local/bin` entries; run `.agents/setup` only when that toolchain is missing or broken. Elsewhere use `mise install`.
2. Read the owning module and its mirrored tests before editing. Command tests follow the source path, for example `src/commands/issue/issue-view.ts` maps to `test/commands/issue/issue-view.test.ts`.
3. Add or update tests for behavior changes. Use `deno task test`, or `deno task update-snapshots` only when intentionally updating snapshots. Set `NO_COLOR=1` for snapshot tests.
4. After changing `graphql/schema.graphql` or a `gql` document in `src/`, run `deno task generate-graphql-types`. Generated GraphQL files are ignored and must not be committed.
5. After changing the command tree or `docs/guides/`, run the guides tests; guide frontmatter owns command-to-guide relationships and is validated against the live command tree.
6. During development run the narrowest relevant test or diagnostic. Use `deno check`, `deno lint`, and Deno tasks; do not use `tsc` or rely on LSP diagnostics.

## Kadoraba live API experiments

`LINEAR_KADORABA_API_KEY` may be available as a dedicated credential for experiments against the Kadoraba test workspace. Prefer a scoped live experiment over speculation when correctness depends on undocumented or uncertain Linear API behavior that deterministic local tests cannot settle.

- The credential's presence provides authentication, not authorization to mutate Linear. Ask the user for explicit authorization for the current experiment, stating why live API evidence is needed and what objects or behavior it will affect.
- Once the user authorizes that scope, run the necessary destructive tests without asking before every command. Ask again before expanding to another workspace, shared pre-existing data, unexpected cost or downtime, or resources that cannot be cleaned up.
- Only check whether the dedicated credential is present. Never print, derive, fingerprint, compare, or otherwise inspect it, and never read, use, or fall back to a pre-existing `LINEAR_API_KEY` for a Kadoraba experiment.
- When the CLI requires `LINEAR_API_KEY`, map the test credential for one process only: `env LINEAR_API_KEY="$LINEAR_KADORABA_API_KEY" <linear-command>`.
- Before the first mutation, run `auth whoami --json` with the same executable. Continue only when `organization.name` is `Kadoraba` or `organization.urlKey` is `kadoraba`; any other identity is a hard stop.
- Use uniquely named test objects and prefer mutating objects created by the experiment instead of shared data. Clean up through the production CLI entry point, allow for propagation delay, and structurally verify the final state. Report every object or asset that cannot be removed.
- Avoid standalone uploads unless upload behavior is the subject of the experiment, because the CLI has no corresponding delete command.
- For pull request acceptance, test the exact requested commit. Run `deno task install` and invoke the compiled binary by absolute path; the Orb's `linear` on `PATH` is a source wrapper, not the installed artifact.
- Do not manufacture live `unknown` outcomes by interrupting mutation requests or breaking authentication or networking. Cover those paths with deterministic fault-injection tests unless the user explicitly authorizes a bounded live experiment and its reconciliation plan.

## Implementation contracts

- Prefer static imports. Use dynamic imports only when required.
- Avoid `any`. Keep GraphQL request results inferred; `client.request(query, variables)` must not need explicit result types.
- Prefer `foo == null` and `foo != null` over separate `undefined` checks.
- Use `@std/fmt/colors` for terminal styling.
- Preserve GraphQL field names and nesting in `--json` output. Paginated JSON retains the connection shape, concatenates `nodes`, and does not flatten or rename fields.
- Before adding a short flag, search global and command options; Cliffy resolves global aliases first.
- Explicit invalid input must fail with guidance, never fall back or fail silently.
- Use `ValidationError`, `NotFoundError`, `AuthError`, or `CliError` from `src/utils/errors.ts`. Wrap command actions with `handleError(error, "Failed to <action>")`.
- Errors go to stderr with the `✗` prefix. Stack traces require `LINEAR_DEBUG=1`.
- When changing Deno permissions, follow the inventory and search procedure in `docs/deno-permissions.md`.

## Verification and release

- `deno task verify-source` is the source verification task: GraphQL type generation, format check, lint, type check, and all non-Keyring tests.
- `deno task verify-release` is the complete local release gate and the pull request source gate; it runs the source verification, which already validates embedded guide contracts.
- Do not push or release without explicit user authorization. When asked to ship, load and follow `.agents/skills/releasing/SKILL.md`; it is the only release procedure.
- The CI release workflow intentionally does not repeat the local release gate. It runs the Linux Keyring integration test, builds five platforms, verifies release assets, attests them, and publishes the GitHub Release.
- Rolling release runs are serialized without canceling in-progress work, retain up to 100 pending `main` updates, and publish a distinct release for every successful run.
