import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { deleteCommand } from "../../../src/commands/issue/issue-delete.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

Deno.test("Issue Delete Command - Accepts UUID For A Single Issue", async () => {
  const issueId = "11111111-1111-4111-8111-111111111111"
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssueDeleteDetails",
      variables: { id: issueId },
      response: {
        data: {
          issue: {
            title: "Moved issue",
            identifier: "TARGET-42",
          },
        },
      },
    },
    {
      queryName: "DeleteIssue",
      variables: { id: issueId },
      response: {
        data: {
          issueDelete: {
            success: true,
            entity: {
              identifier: "TARGET-42",
              title: "Moved issue",
            },
          },
        },
      },
    },
  ])
  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await deleteCommand.parse([issueId, "--confirm"])
  } finally {
    logStub.restore()
    await cleanup()
  }

  assertEquals(logs, [
    "✓ Successfully deleted issue: TARGET-42: Moved issue",
  ])
})
