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
