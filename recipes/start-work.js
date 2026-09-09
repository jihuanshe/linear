#!/usr/bin/env -S deno run --allow-run --allow-env --allow-read --allow-write
// Deliberately one attempt: the base file reserves this setup invocation.
// On failure, inspect the printed step and continue with native commands.
async function linear(args) {
  return await new Deno.Command(Deno.env.get("LINEAR_BIN") ?? "linear", {
    args,
    stdout: "piped",
    stderr: "inherit",
  }).output()
}
if (import.meta.main) {
  let localContextCreated = false
  try {
    const [vcs, issue, context, baseFile, state, fromRef] = Deno.args
    if (!["git", "jj"].includes(vcs) || !state || Deno.args.length > 6) {
      throw new Error(
        "Usage: deno run --allow-run --allow-env --allow-read --allow-write recipes/start-work.js git|jj ISSUE BRANCH_OR_JJ_DESCRIPTION BASE_FILE STATE [FROM_REF]",
      )
    }
    const read = await linear(["issue", "view", issue, "--json"])
    if (!read.success) throw new Error("Issue read failed before local changes")
    const text = new TextDecoder().decode(read.stdout)
    const base = JSON.parse(text)
    if (!base.organization?.id || !base.issue?.id) {
      throw new Error("Use a CLI with the current read/base contract")
    }
    // Never overwrite a previous attempt or silently refresh its discussion basis.
    await Deno.writeTextFile(baseFile, text, { createNew: true })
    const description =
      `${context}\n\nLinear-issue: Fixes ${base.issue.identifier}`
    const command = vcs === "git"
      ? new Deno.Command("git", {
        args: ["switch", "-c", context, fromRef ?? "HEAD"],
        stdout: "inherit",
        stderr: "inherit",
      })
      : new Deno.Command("jj", {
        args: ["new", fromRef ?? "@", "-m", description],
        stdout: "inherit",
        stderr: "inherit",
      })
    const created = await command.output()
    if (!created.success) {
      throw new Error(
        `Local ${vcs} command failed; inspect native state and the saved base before continuing`,
      )
    }
    localContextCreated = true
    console.error(
      `Local ${vcs} context created. Updating ${base.issue.identifier} using ${baseFile}.`,
    )
    const updated = await linear([
      "issue",
      "update",
      base.issue.id,
      "--base-file",
      baseFile,
      "--state",
      state,
      "--json",
    ])
    await Deno.stdout.write(updated.stdout)
    if (!updated.success) {
      throw new Error(
        "State update failed; keep the existing branch/change and base file, inspect the result, then run issue update separately",
      )
    }
  } catch (error) {
    console.error(
      `${
        localContextCreated ? "Local context already exists. " : ""
      }${error.message}`,
    )
    Deno.exit(1)
  }
}
