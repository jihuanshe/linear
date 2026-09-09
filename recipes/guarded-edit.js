#!/usr/bin/env -S deno run --allow-run --allow-env --allow-read --allow-write
// Two explicit steps around the discussion/edit. No automatic retries or ledger.
async function cli(args) {
  return await new Deno.Command(Deno.env.get("LINEAR_BIN") ?? "linear", {
    args,
    stdout: "piped",
    stderr: "inherit",
  }).output()
}
export async function prepare(issue, directory) {
  // An existing directory is a different discussion; never overwrite its basis.
  await Deno.mkdir(directory)
  const result = await cli(["issue", "view", issue, "--json"])
  if (!result.success) throw new Error("Read failed; no basis was saved")
  const text = new TextDecoder().decode(result.stdout)
  const original = JSON.parse(text)
  if (!original.organization?.id || !original.issue?.id) {
    throw new Error("Expected the current {organization, issue} read contract")
  }
  await Deno.writeTextFile(`${directory}/original.json`, text, {
    createNew: true,
  })
  await Deno.writeTextFile(
    `${directory}/desired.md`,
    original.issue.description ?? "",
    { createNew: true },
  )
  console.log(
    `Read ${original.issue.identifier}. Discuss the saved original.json and edit ${directory}/desired.md, then run submit.`,
  )
}
export async function submit(directory) {
  const original = JSON.parse(
    await Deno.readTextFile(`${directory}/original.json`),
  )
  if (!original.issue?.id || !original.organization?.id) {
    throw new Error("Saved basis is missing identity")
  }
  // No new read is saved here. The CLI owns final comparison and domain guards.
  const result = await cli([
    "issue",
    "update",
    original.issue.id,
    "--base-file",
    `${directory}/original.json`,
    "--description-file",
    `${directory}/desired.md`,
    "--json",
  ])
  await Deno.stdout.write(result.stdout)
  return result.code
}
if (import.meta.main) {
  try {
    const [action, ...args] = Deno.args
    if (action === "prepare" && args.length === 2) await prepare(...args)
    else if (action === "submit" && args.length === 1) {
      Deno.exit(await submit(...args))
    } else {throw new Error(
        "Usage: recipes/guarded-edit.js prepare ISSUE NEW_DIRECTORY | submit DIRECTORY",
      )}
  } catch (error) {
    console.error(error.message)
    Deno.exit(1)
  }
}
