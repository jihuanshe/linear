#!/usr/bin/env -S deno run --allow-run --allow-env
// Trailer example: Linear-issue: Fixes ENG-123
export function issueRevset(identifier) {
  const id = identifier.toUpperCase()
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) {
    throw new Error("Provide one complete issue identifier, such as ENG-123")
  }
  return `description(regex:${
    JSON.stringify(`(?m)^Linear-issue:.*\\b${id}\\b`)
  })`
}
if (import.meta.main) {
  try {
    if (Deno.args.length !== 1) {
      throw new Error(
        "Usage: deno run --allow-run --allow-env recipes/jj-commits.js ISSUE",
      )
    }
    const id = Deno.args[0].toUpperCase()
    const revset = issueRevset(id)
    const check = await new Deno.Command(
      Deno.env.get("LINEAR_BIN") ?? "linear",
      { args: ["issue", "title", id], stdout: "null", stderr: "inherit" },
    ).output()
    if (!check.success) Deno.exit(check.code)
    const result = await new Deno.Command("jj", {
      args: [
        "log",
        "-r",
        revset,
        "-p",
        "--git",
        "--no-graph",
        "-T",
        "builtin_log_compact_full_description",
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).output()
    Deno.exit(result.code)
  } catch (error) {
    console.error(error.message)
    Deno.exit(1)
  }
}
