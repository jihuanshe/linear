import { Confirm } from "@cliffy/prompt"
import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { deleteCommand } from "../../../src/commands/team/team-delete.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

Deno.test("Team Delete Command - Cancel Before Moving Issues", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "SOURCE" },
      response: {
        data: {
          teams: {
            nodes: [{ id: "source-team-id" }],
          },
        },
      },
    },
    {
      queryName: "GetTeamDetails",
      variables: { id: "source-team-id" },
      response: {
        data: {
          team: {
            id: "source-team-id",
            key: "SOURCE",
            name: "Source Team",
            issueCount: 1,
            issues: {
              nodes: [{ id: "issue-1" }],
            },
          },
        },
      },
    },
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "TARGET" },
      response: {
        data: {
          teams: {
            nodes: [{ id: "target-team-id" }],
          },
        },
      },
    },
  ])

  const terminalStub = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  let confirmCalls = 0
  const confirmStub = stub(Confirm, "prompt", () => {
    confirmCalls += 1
    return Promise.resolve(false)
  })

  try {
    await deleteCommand.parse([
      "SOURCE",
      "--move-issues",
      "TARGET",
    ])
    assertEquals(confirmCalls, 1)
  } finally {
    confirmStub.restore()
    terminalStub.restore()
    await cleanup()
  }
})

Deno.test("Team Delete Command - Dry Run Stops Before Mutations", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "SOURCE" },
      response: {
        data: { teams: { nodes: [{ id: "source-team-id" }] } },
      },
    },
    {
      queryName: "GetTeamDetails",
      variables: { id: "source-team-id" },
      response: {
        data: {
          team: {
            id: "source-team-id",
            key: "SOURCE",
            name: "Source Team",
            issueCount: 12,
          },
        },
      },
    },
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "TARGET" },
      response: {
        data: { teams: { nodes: [{ id: "target-team-id" }] } },
      },
    },
  ])
  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await deleteCommand.parse([
      "SOURCE",
      "--move-issues",
      "TARGET",
      "--dry-run",
    ])
  } finally {
    logStub.restore()
    await cleanup()
  }

  assertEquals(logs, [
    "Would delete team SOURCE (Source Team)",
    "Would move 12 issue(s) to TARGET",
  ])
})

Deno.test("Team Delete Command - Reports Moved Issue Identifiers", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "SOURCE" },
      response: {
        data: { teams: { nodes: [{ id: "source-team-id" }] } },
      },
    },
    {
      queryName: "GetTeamDetails",
      variables: { id: "source-team-id" },
      response: {
        data: {
          team: {
            id: "source-team-id",
            key: "SOURCE",
            name: "Source Team",
            issueCount: 1,
          },
        },
      },
    },
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "TARGET" },
      response: {
        data: { teams: { nodes: [{ id: "target-team-id" }] } },
      },
    },
    {
      queryName: "GetTeamIssuesForMove",
      variables: {
        teamId: "source-team-id",
        first: 100,
        after: undefined,
      },
      response: {
        data: {
          team: {
            issues: {
              nodes: [{ id: "issue-id", identifier: "SOURCE-1" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    {
      queryName: "MoveIssueToTeam",
      variables: { id: "issue-id", teamId: "target-team-id" },
      response: {
        data: {
          issueUpdate: {
            success: true,
            issue: { identifier: "TARGET-42" },
          },
        },
      },
    },
    {
      queryName: "DeleteTeam",
      variables: { id: "source-team-id" },
      response: { data: { teamDelete: { success: true } } },
    },
  ])
  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await deleteCommand.parse([
      "SOURCE",
      "--move-issues",
      "TARGET",
      "--force",
    ])
  } finally {
    logStub.restore()
    await cleanup()
  }

  assertEquals(logs, [
    "✓ Moved SOURCE-1 → TARGET-42",
    "✓ Moved 1 issue(s) to target team",
    "✓ Successfully deleted team: SOURCE: Source Team",
  ])
})

Deno.test("Team Delete Command - Prompt Disabled Requires Force", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "SOURCE" },
      response: {
        data: { teams: { nodes: [{ id: "source-team-id" }] } },
      },
    },
    {
      queryName: "GetTeamDetails",
      variables: { id: "source-team-id" },
      response: {
        data: {
          team: {
            id: "source-team-id",
            key: "SOURCE",
            name: "Source Team",
            issueCount: 0,
          },
        },
      },
    },
  ])
  const original = Deno.env.get("LINEAR_PROMPT_DISABLED")
  Deno.env.set("LINEAR_PROMPT_DISABLED", "1")
  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  try {
    await deleteCommand.parse(["SOURCE"])
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "EXIT") throw error
  } finally {
    exitStub.restore()
    errorStub.restore()
    if (original == null) Deno.env.delete("LINEAR_PROMPT_DISABLED")
    else Deno.env.set("LINEAR_PROMPT_DISABLED", original)
    await cleanup()
  }

  assertEquals(
    errorLogs.some((line) =>
      line.includes(
        "Interactive prompting is disabled by LINEAR_PROMPT_DISABLED",
      )
    ),
    true,
  )
  assertEquals(
    errorLogs.some((line) => line.includes("Use --force")),
    true,
  )
})
