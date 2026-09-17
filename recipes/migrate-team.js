#!/usr/bin/env -S deno run --allow-run --allow-env --allow-read --allow-write
// Freeze original reads and a v2 manifest; plan/apply own execution and recovery.
async function read(args) {
  const result = await new Deno.Command(
    Deno.env.get("LINEAR_BIN") ?? "linear",
    { args, stdout: "piped", stderr: "piped" },
  ).output()
  if (!result.success) {
    throw new Error(`Read failed: ${new TextDecoder().decode(result.stderr)}`)
  }
  return JSON.parse(new TextDecoder().decode(result.stdout))
}
async function teams(source, target) {
  const result = await read([
    "api",
    `query MigrationTeams($keys: [String!]!, $after: String) {
    organization { id urlKey }
    teams(filter: {key: {in: $keys}}, first: 100, after: $after) {
      nodes { id key } pageInfo { hasNextPage endCursor }
    }
  }`,
    "--variables-json",
    JSON.stringify({ keys: [source, target] }),
    "--paginate",
  ])
  if (
    result.errors?.length || !result.data?.organization?.id ||
    !result.data.organization.urlKey ||
    result.data.teams?.pageInfo?.hasNextPage !== false
  ) {
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
  // Reserve a new directory before reads. Never convert or overwrite old ledgers.
  await Deno.mkdir(directory)
  const identity = await teams(source.toUpperCase(), target.toUpperCase())
  const result = await read([
    "api",
    `query MigrationIssues($team: ID!, $after: String) {
      issues(filter: {team: {id: {eq: $team}}}, includeArchived: true, first: 100, after: $after) {
        nodes { id } pageInfo { hasNextPage endCursor }
      }
    }`,
    "--variables-json",
    JSON.stringify({ team: identity.source.id }),
    "--paginate",
  ])
  const connection = result.data?.issues
  if (
    result.errors?.length || connection?.pageInfo?.hasNextPage !== false ||
    !Array.isArray(connection.nodes)
  ) throw new Error("Incomplete source issue collection")
  const ids = connection.nodes.map((i) => i.id)
  if (
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length
  ) throw new Error("Invalid or duplicate issue IDs")
  if (ids.length === 0) {
    console.log("No work: source team has no issues; no manifest generated.")
    return
  }
  const manifest = {
    schemaVersion: 2,
    workspace: identity.organization.urlKey,
    issues: [],
  }
  for (const [index, id] of ids.entries()) {
    const base = await read(["issue", "view", id, "--json"])
    if (
      base.organization?.id !== identity.organization.id ||
      base.organization.urlKey !== identity.organization.urlKey ||
      base.issue?.id !== id || base.issue.team?.id !== identity.source.id
    ) {
      throw new Error(
        `Issue scope changed while freezing ${id}; no moves executed`,
      )
    }
    if (base.issue.archivedAt != null || base.issue.trashed === true) {
      throw new Error(
        `Issue ${id} is archived or trashed; decide its lifecycle separately before freezing a new scope. No moves executed.`,
      )
    }
    const baseFile = `${index}.base.json`
    await Deno.writeTextFile(
      `${directory}/${baseFile}`,
      JSON.stringify(base, null, 2),
      { createNew: true },
    )
    manifest.issues.push({
      operation: "update",
      identifier: id,
      set: { team: identity.target.id },
      baseFile,
    })
  }
  // Publish only after every original read passes; an incomplete freeze cannot run.
  await Deno.writeTextFile(
    `${directory}/manifest.json`,
    JSON.stringify(manifest, null, 2),
    { createNew: true },
  )
  console.log(JSON.stringify(manifest, null, 2))
}
if (import.meta.main) {
  try {
    const [action, ...args] = Deno.args
    if (action === "freeze" && args.length === 3) await freeze(...args)
    else {throw new Error(
        "Usage: migrate-team.js freeze SOURCE_KEY TARGET_KEY NEW_DIRECTORY",
      )}
  } catch (error) {
    console.error(error.message)
    Deno.exit(1)
  }
}
