import { snapshotTest } from "@cliffy/testing"
import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { commentDeleteCommand } from "../../../src/commands/issue/issue-comment-delete.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

// Test deleting a comment
await snapshotTest({
  name: "Issue Comment Delete Command - Success",
  meta: import.meta,
  colors: false,
  args: ["comment-uuid-123", "--confirm"],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      {
        queryName: "DeleteComment",
        response: {
          data: {
            commentDelete: {
              success: true,
            },
          },
        },
      },
    ])

    try {
      await commentDeleteCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

Deno.test("Issue Comment Delete Command - prompt disabled blocks deletion", async () => {
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
    await commentDeleteCommand.parse(["comment-uuid-123"])
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "EXIT") throw error
  } finally {
    exitStub.restore()
    errorStub.restore()
    if (original == null) Deno.env.delete("LINEAR_PROMPT_DISABLED")
    else Deno.env.set("LINEAR_PROMPT_DISABLED", original)
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
    errorLogs.some((line) => line.includes("Use --confirm")),
    true,
  )
})
