#!/usr/bin/env -S deno run --allow-run --allow-env --allow-read --allow-write
// Fixed scope plus receipts, not a resume engine. A failed run never auto-replays.
async function cli(args) {
  const result = await new Deno.Command(
    Deno.env.get("LINEAR_BIN") ?? "linear",
    { args, stdout: "piped", stderr: "piped" },
  ).output()
  return {
    ...result,
    text: new TextDecoder().decode(result.stdout),
    diagnostic: new TextDecoder().decode(result.stderr),
  }
}
async function read(args) {
  const result = await cli(args)
  if (!result.success) throw new Error(`Read failed: ${result.diagnostic}`)
  return JSON.parse(result.text)
}
function assertMigratable(issue) {
  if (issue.archivedAt != null || issue.trashed === true) {
    throw new Error(
      `Issue ${issue.id} is archived or trashed; decide its lifecycle separately before freezing a new scope. No moves executed.`,
    )
  }
}
async function teams(source, target) {
  const result = await read([
    "api",
    `query MigrationTeams($keys: [String!]!) {
    organization { id urlKey }
    teams(filter: {key: {in: $keys}}, first: 100) { nodes { id key } }
  }`,
    "--variables-json",
    JSON.stringify({ keys: [source, target] }),
  ])
  if (result.errors?.length || !result.data?.organization) {
    throw new Error("Incomplete team identity lookup")
  }
  const sourceTeam = result.data.teams.nodes.filter((t) => t.key === source)
  const targetTeam = result.data.teams.nodes.filter((t) => t.key === target)
  if (
    sourceTeam.length !== 1 || targetTeam.length !== 1 ||
    sourceTeam[0].id === targetTeam[0].id
  ) throw new Error("Choose two distinct existing teams")
  return {
    organization: result.data.organization,
    source: sourceTeam[0],
    target: targetTeam[0],
  }
}
export async function freeze(source, target, directory) {
  const identity = await teams(source.toUpperCase(), target.toUpperCase())
  const connection = await read([
    "issue",
    "query",
    "--team",
    identity.source.key,
    "--include-archived",
    "--limit",
    "0",
    "--json",
  ])
  if (
    connection.pageInfo?.hasNextPage !== false ||
    !Array.isArray(connection.nodes)
  ) throw new Error("Incomplete source issue collection")
  const ids = connection.nodes.map((i) => i.id)
  if (
    ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length
  ) throw new Error("Invalid or duplicate issue IDs")
  await Deno.mkdir(directory)
  const scope = { ...identity, readAt: new Date().toISOString(), issues: [] }
  for (const [index, issue] of connection.nodes.entries()) {
    const base = await read(["issue", "view", issue.id, "--json"])
    if (
      base.organization?.id !== identity.organization.id ||
      base.issue?.id !== issue.id || base.issue.team?.id !== identity.source.id
    ) {
      throw new Error(
        `Issue scope changed while freezing ${issue.id}; no moves executed`,
      )
    }
    assertMigratable(base.issue)
    const baseFile = `${index}.base.json`
    await Deno.writeTextFile(
      `${directory}/${baseFile}`,
      JSON.stringify(base, null, 2),
      { createNew: true },
    )
    scope.issues.push({ id: issue.id, identifier: issue.identifier, baseFile })
  }
  // An incomplete freeze has no scope.json and cannot be executed.
  await Deno.writeTextFile(
    `${directory}/scope.json`,
    JSON.stringify(scope, null, 2),
    { createNew: true },
  )
  console.log(JSON.stringify(scope, null, 2))
}
export async function move(directory) {
  const scope = JSON.parse(await Deno.readTextFile(`${directory}/scope.json`))
  // Check every saved input before the first move, without replacing its basis.
  const ids = new Set()
  for (const issue of scope.issues) {
    if (ids.has(issue.id) || !/^\d+\.base\.json$/.test(issue.baseFile)) {
      throw new Error("Invalid or duplicate frozen issue entry")
    }
    ids.add(issue.id)
    const base = JSON.parse(
      await Deno.readTextFile(`${directory}/${issue.baseFile}`),
    )
    if (
      base.organization?.id !== scope.organization.id ||
      base.issue?.id !== issue.id || base.issue.team?.id !== scope.source.id
    ) {
      throw new Error(
        `Saved basis does not match the frozen scope: ${issue.id}`,
      )
    }
    assertMigratable(base.issue)
  }
  const current = await teams(scope.source.key, scope.target.key)
  if (
    current.organization.id !== scope.organization.id ||
    current.source.id !== scope.source.id ||
    current.target.id !== scope.target.id
  ) throw new Error("Workspace or team identity changed; no moves executed")
  const receipts = `${directory}/receipts.jsonl`
  // Existing receipts require explicit reconciliation and a newly selected scope.
  const file = await Deno.open(receipts, { write: true, createNew: true })
  file.close()
  for (const [index, issue] of scope.issues.entries()) {
    const intent = {
      id: issue.id,
      before: issue.identifier,
      targetTeamId: scope.target.id,
    }
    await Deno.writeTextFile(
      receipts,
      JSON.stringify({ ...intent, effect: "unknown", phase: "dispatch" }) +
        "\n",
      { append: true },
    )
    const result = await cli([
      "issue",
      "update",
      issue.id,
      "--base-file",
      `${directory}/${issue.baseFile}`,
      "--team",
      scope.target.id,
      "--json",
    ])
    await Deno.writeTextFile(`${directory}/${index}.stdout.json`, result.text, {
      createNew: true,
    })
    await Deno.writeTextFile(
      `${directory}/${index}.stderr.txt`,
      result.diagnostic,
      { createNew: true },
    )
    let output
    try {
      output = JSON.parse(result.text)
    } catch {
      throw new Error(
        `Unknown result for ${issue.id}; reconcile this stable ID before choosing later objects`,
      )
    }
    const after = output.data?.issue?.identifier
    await Deno.writeTextFile(
      receipts,
      JSON.stringify({
        ...intent,
        ...(after ? { after } : {}),
        phase: "result",
        result: output,
      }) + "\n",
      { append: true },
    )
    console.log(
      JSON.stringify({
        ...intent,
        ...(after ? { after } : {}),
        result: output,
      }),
    )
    if (
      !result.success || output.ok !== true ||
      !["applied", "none"].includes(output.effect)
    ) {
      throw new Error(
        `Stopped at ${issue.id} (${
          output.effect ?? "unknown"
        }); retain receipts, reconcile unknown effects, and explicitly select any later objects`,
      )
    }
    if (!after) {
      throw new Error(
        `Confirmed result for ${issue.id} has no resulting identifier; retain its receipt and read the stable UUID before selecting later objects`,
      )
    }
  }
  console.error(
    "Selected moves finished. Re-read the source team; delete it separately only when it is empty. Do not rerun this directory.",
  )
}
if (import.meta.main) {
  try {
    const [action, ...args] = Deno.args
    if (action === "freeze" && args.length === 3) await freeze(...args)
    else if (action === "move" && args.length === 1) await move(...args)
    else {throw new Error(
        "Usage: recipes/migrate-team.js freeze SOURCE_KEY TARGET_KEY NEW_DIRECTORY | move DIRECTORY",
      )}
  } catch (error) {
    console.error(error.message)
    Deno.exit(1)
  }
}
