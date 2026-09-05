import { snapshotTest } from "@cliffy/testing"
import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { commentUpdateCommand } from "../../../src/commands/issue/issue-comment-update.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

// Test updating a comment with body flag
await snapshotTest({
  name: "Issue Comment Update Command - With Body Flag",
  meta: import.meta,
  colors: false,
  args: ["comment-uuid-123", "--body", "This is the updated comment text"],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      {
        queryName: "UpdateComment",
        response: {
          data: {
            commentUpdate: {
              success: true,
              comment: {
                id: "comment-uuid-123",
                body: "This is the updated comment text",
                updatedAt: "2024-01-15T14:30:00Z",
                url: "https://linear.app/issue/TEST-123#comment-uuid-123",
                user: {
                  name: "testuser",
                  displayName: "Test User",
                },
              },
            },
          },
        },
      },
    ])

    try {
      await commentUpdateCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

Deno.test("Issue Comment Update Command - JSON requires an explicit body", async () => {
  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  try {
    await commentUpdateCommand.parse(["comment-uuid-123", "--json"])
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "EXIT") throw error
  } finally {
    errorStub.restore()
    exitStub.restore()
  }

  assertEquals(
    errorLogs.some((line) =>
      line.includes("JSON mode requires --body or --body-file")
    ),
    true,
  )
})

await snapshotTest({
  name: "Issue Comment Update Command - JSON",
  meta: import.meta,
  colors: false,
  args: ["comment-uuid-123", "--body", "Updated as JSON", "--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      {
        queryName: "UpdateComment",
        response: {
          data: {
            commentUpdate: {
              success: true,
              comment: {
                id: "comment-uuid-123",
                body: "Updated as JSON",
                updatedAt: "2024-01-15T14:30:00Z",
                url: "https://linear.app/issue/TEST-123#comment-uuid-123",
                user: { name: "testuser", displayName: "Test User" },
              },
            },
          },
        },
      },
    ])

    try {
      await commentUpdateCommand.parse()
    } finally {
      await cleanup()
    }
  },
})
