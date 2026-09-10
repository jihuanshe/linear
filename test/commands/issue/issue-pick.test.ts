import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { pickCommand } from "../../../src/commands/issue/issue-pick.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

// `issue pick` with no issue id lists unstarted issues via the shared
// query helper with the configured sort, defaulting to priority.
Deno.test("Issue Pick Command - Does Not Require Sort Config", async () => {
  // Return no issues so the command stops at its empty-list check instead of
  // opening the interactive prompt. Reaching that check confirms the request
  // went out with the default priority sort.
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      variables: { after: "next" },
      response: {
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      queryName: "GetIssuesForQuery",
      variables: {
        filter: {
          team: { key: { eq: "ENG" } },
          state: { type: { in: ["unstarted"] } },
          assignee: { isMe: { eq: true } },
        },
        first: 100,
        sort: [
          { workflowState: { order: "Descending" } },
          { priority: { nulls: "last", order: "Descending" } },
          { manual: { nulls: "last", order: "Ascending" } },
        ],
      },
      response: {
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "next" },
          },
        },
      },
    },
  ], { LINEAR_TEAM_ID: "ENG", NO_COLOR: "true" })

  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number): never => {
    throw new Error("EXIT")
  })

  try {
    await pickCommand.parse([])
  } catch {
    // expected: handleError calls the stubbed Deno.exit
  } finally {
    errorStub.restore()
    exitStub.restore()
    await cleanup()
  }

  const output = errorLogs.join("\n")
  assertEquals(output.includes("Sort must be provided"), false)
  assertEquals(output.includes("Unstarted issues not found"), true)
  assertEquals(server.graphqlRequests.length, 2)
})

Deno.test("Issue Pick Command - selection prints one identifier and performs no mutation", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      response: {
        data: {
          issues: {
            nodes: [{
              id: "issue-id",
              identifier: "ENG-123",
              title: "Pick this",
              priority: 2,
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ], { LINEAR_TEAM_ID: "ENG" })
  const { Select } = await import("../../../src/utils/prompt.ts")
  const logs: string[] = []
  const prompt = stub(Select, "prompt", (options) => {
    assertEquals(options.writer, Deno.stderr)
    return Promise.resolve("ENG-123")
  })
  const log = stub(console, "log", (...values: unknown[]) => {
    logs.push(values.join(" "))
  })
  try {
    await pickCommand.parse([])
    assertEquals(logs, ["ENG-123"])
    assertEquals(server.graphqlRequests.length, 1)
    assertEquals(server.graphqlRequests[0].query.includes("mutation"), false)
  } finally {
    prompt.restore()
    log.restore()
    await cleanup()
  }
})
