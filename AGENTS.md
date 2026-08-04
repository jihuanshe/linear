# Repository Workflow

## Sources of truth

| Concern                              | Source                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| Runtime version and developer tasks  | `mise.toml`, `deno.json`                                                      |
| Orb bootstrap and source wrapper     | `.agents/setup`, `.agents/resume`                                             |
| Linear GraphQL schema and generation | `graphql/schema.graphql`, `codegen.ts`                                        |
| Production code and mirrored tests   | `src/`, `test/`                                                               |
| Deno permission changes              | `docs/deno-permissions.md`                                                    |
| Linear CLI Skill source              | `.agents/skills/linear-cli/SKILL.template.md`                                 |
| Generated Linear CLI Skill           | `.agents/skills/linear-cli/SKILL.md`, `.agents/skills/linear-cli/references/` |
| Release procedure                    | `.agents/skills/releasing/SKILL.md`                                           |
| CI release implementation            | `.github/workflows/ship-main.yml`                                             |
| Cumulative downstream changes        | `CHANGELOG.md`                                                                |

`AGENTS.md` is the repository guidance source. `CLAUDE.md` is only a compatibility pointer to this file.

## Development loop

1. Use Deno `2.9.4`. In an Orb, run `.agents/setup` only when the toolchain is missing or broken; elsewhere use `mise install`.
2. Read the owning module and its mirrored tests before editing. Command tests follow the source path, for example `src/commands/issue/issue-view.ts` maps to `test/commands/issue/issue-view.test.ts`.
3. Add or update tests for behavior changes. Use `deno task test`, or `deno task update-snapshots` only when intentionally updating snapshots. Set `NO_COLOR=1` for snapshot tests.
4. After changing `graphql/schema.graphql` or a `gql` document in `src/`, run `deno task generate-graphql-types`. Generated GraphQL files are ignored and must not be committed.
5. After changing the command tree, help output, or `SKILL.template.md`, run `deno task generate-skill-docs` and commit the generated Skill files.
6. During development run the narrowest relevant test or diagnostic. Use `deno check`, `deno lint`, and Deno tasks; do not use `tsc` or rely on LSP diagnostics.

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
- `deno task verify-release` is the complete local release gate: source verification plus generated Skill verification.
- Do not push or release without explicit user authorization. When asked to ship, load and follow `.agents/skills/releasing/SKILL.md`; it is the only release procedure.
- The CI release workflow intentionally does not repeat the local release gate. It runs the Linux Keyring integration test, builds five platforms, verifies release assets, attests them, and publishes the GitHub Release.
