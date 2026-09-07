# Cliffy flags 1.2.1 selective empty values

This directory contains the complete runtime modules and [MIT license](LICENSE) from [@cliffy/flags 1.2.1](https://jsr.io/@cliffy/flags/1.2.1). Source bytes were extracted using the module sizes in Deno's dependency graph, excluding Deno cache metadata. Original exports, error classes, external dependency versions and formatting are retained.

The only source changes are `FlagOptions.preserveEmpty?: boolean` in `types.ts` and two guards in `flags.ts`'s `parseNext`: skip empty arguments and convert empty results to `undefined` only when preservation is disabled. The default remains disabled. This lets selected update fields distinguish omission from an explicit empty string without inventing required/default metadata or scanning raw arguments outside the parser.

The root `deno.json` pins Command 1.2.1 and overrides its exact `jsr:@cliffy/flags@1.2.1` dependency. Command's option types inherit `FlagOptions`, so the same selective option controls both typing and parsing. Only vendored TypeScript is excluded from formatting and lint; this README remains checked. Regression coverage lives in [the parser and update boundary tests](../../test/commands/empty-update-values.test.ts).

Remove this directory, the import override, the vendor format/lint exclusions and the local `preserveEmpty` options when upstream supplies an equivalent selective empty-string API and the boundary tests pass using it. Do not replace this patch with a global parser behavior change, fake required/default options or raw-argument scanning.
