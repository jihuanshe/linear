# Cliffy flags 1.3.1 selective empty values

This directory contains the complete runtime modules and [MIT license](LICENSE) from [@cliffy/flags 1.3.1](https://jsr.io/@cliffy/flags/1.3.1). Source bytes were extracted using the module sizes in Deno's dependency graph, excluding Deno cache metadata. Original exports, error classes, external dependency versions and formatting are retained.

The only source changes are `FlagOptions.preserveEmpty?: boolean` in `types.ts` and two guards in `flags.ts`'s `parseNext`: skip empty arguments and convert empty results to `undefined` only when preservation is disabled. The default remains disabled. This lets selected update fields distinguish omission from an explicit empty string without inventing required/default metadata or scanning raw arguments outside the parser.

Upstream deliberately treats empty optional option values as omission ([Cliffy PR #805](https://github.com/c4spar/cliffy/pull/805)); 1.3.1 has no per-option preservation API. The local opt-in also bypasses the required-option empty-value rejection added in [PR #922](https://github.com/c4spar/cliffy/pull/922), allowing domain validation to reject empty paths. Options without the opt-in keep upstream validation.

The root `deno.json` pins Command 1.3.1 and overrides its published `jsr:@cliffy/flags@^1.3.1` import. Command's option types inherit `FlagOptions`, so the same selective option controls both typing and parsing. Only vendored TypeScript is excluded from formatting and lint; this README remains checked. Regression coverage lives in [the parser and update boundary tests](../../test/commands/empty-update-values.test.ts).

Keep upgrading Command: refresh the full flags runtime from the matching release, reapply only the selective patch, update the override to match Command's published import, and run `mise exec -- deno task test test/commands/empty-update-values.test.ts` followed by the full `verify-release` gate. Do not carry an older parser wholesale or weaken newer upstream validation.

Remove this directory, the import override, the vendor format/lint exclusions and the local `preserveEmpty` options when upstream supplies an equivalent selective empty-string API and the boundary tests pass using it. Do not replace this patch with a global parser behavior change, fake required/default options or raw-argument scanning.
