import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { deleteCommand } from "../../../src/commands/team/team-delete.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

async function runDelete(issueCount: number, args: string[]) {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      response: { data: { teams: { nodes: [{ id: "team-id" }] } } },
    },
    {
      queryName: "GetTeamDetails",
      response: {
        data: {
          team: { id: "team-id", key: "ENG", name: "Engineering", issueCount },
        },
      },
    },
    {
      queryName: "DeleteTeam",
      response: { data: { teamDelete: { success: true } } },
    },
  ])
  const logs: string[] = []
  const errors: string[] = []
  const log = stub(console, "log", (...values: unknown[]) => {
    logs.push(values.join(" "))
  })
  const err = stub(console, "error", (...values: unknown[]) => {
    errors.push(values.join(" "))
  })
  const exit = stub(Deno, "exit", () => {
    throw new Error("EXIT")
  })
  try {
    try {
      await deleteCommand.parse(["ENG", ...args])
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "EXIT") throw error
    }
    return {
      logs,
      errors,
      requests: server.graphqlRequests.map((r) => r.query),
    }
  } finally {
    log.restore()
    err.restore()
    exit.restore()
    await cleanup()
  }
}
Deno.test("Team delete refuses a nonempty team with no migration or deletion", async () => {
  const result = await runDelete(2, ["--force"])
  assertEquals(
    result.errors.some((e) => e.includes("requires an empty team")),
    true,
  )
  assertEquals(result.requests.length, 2)
  assertEquals(
    result.requests[1].includes("issueCount(includeArchived: true)"),
    true,
  )
})
Deno.test("Team delete dry run is read only", async () => {
  const result = await runDelete(0, ["--dry-run"])
  assertEquals(result.logs, ["Would delete team ENG (Engineering)"])
  assertEquals(result.requests.length, 2)
})
Deno.test("Team delete rereads the same team immediately before deletion", async () => {
  const result = await runDelete(0, ["--force", "--json"])
  assertEquals(
    result.requests.filter((q) => q.includes("query GetTeamDetails")).length,
    2,
  )
  const output = JSON.parse(result.logs[0])
  assertEquals(output.ok, true)
  assertEquals(output.effect, "applied")
  assertEquals(output.data.team.id, "team-id")
})

Deno.test("Team delete refuses issues added while confirmation is open", async () => {
  const { Confirm } = await import("../../../src/utils/prompt.ts")
  const team = { id: "team-id", key: "ENG", name: "Engineering", issueCount: 0 }
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      response: { data: { teams: { nodes: [{ id: "team-id" }] } } },
    },
    { queryName: "GetTeamDetails", response: { data: { team } } },
  ])
  const terminal = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const prompt = stub(Confirm, "prompt", () => {
    team.issueCount = 1
    return Promise.resolve(true)
  })
  const errors: string[] = []
  const error = stub(console, "error", (...values: unknown[]) => {
    errors.push(values.join(" "))
  })
  const exit = stub(Deno, "exit", () => {
    throw new Error("EXIT")
  })
  try {
    try {
      await deleteCommand.parse(["ENG"])
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "EXIT") throw err
    }
    assertEquals(
      errors.some((message) => message.includes("requires an empty team")),
      true,
    )
    assertEquals(server.graphqlRequests.length, 3)
    assertEquals(
      server.graphqlRequests.some((request) =>
        request.query.includes("mutation")
      ),
      false,
    )
  } finally {
    terminal.restore()
    prompt.restore()
    error.restore()
    exit.restore()
    await cleanup()
  }
})
