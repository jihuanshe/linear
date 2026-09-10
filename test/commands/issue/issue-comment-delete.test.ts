import { snapshotTest } from "@cliffy/testing"
import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { fromFileUrl } from "@std/path"
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

for (const success of [true, false]) {
  Deno.test(`Comment delete JSON preserves confirmed=${success} effects`, async () => {
    const { server, cleanup } = await setupMockLinearServer([{
      queryName: "DeleteComment",
      variables: { id: "comment-id" },
      response: { data: { commentDelete: { success } } },
    }])
    try {
      const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          main,
          "issue",
          "comment",
          "delete",
          "comment-id",
          "--confirm",
          "--json",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output()
      const stdout = new TextDecoder().decode(result.stdout)
      assertEquals(result.code, success ? 0 : 1, stdout)
      assertEquals(new TextDecoder().decode(result.stderr), "")
      const output = JSON.parse(stdout)
      assertEquals(output.ok, success)
      assertEquals(output.effect, success ? "applied" : "unknown")
      if (success) {
        assertEquals(output.data, { id: "comment-id", success: true })
      } else assertEquals(output.data.commentDelete, { success: false })
      assertEquals(server.graphqlRequests.length, 1)
    } finally {
      await cleanup()
    }
  })
}

Deno.test("Comment delete cancellation reports no effect and never dispatches", async () => {
  const { Confirm } = await import("../../../src/utils/prompt.ts")
  const { server, cleanup } = await setupMockLinearServer([])
  const terminal = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const prompt = stub(Confirm, "prompt", () => Promise.resolve(false))
  const output: string[] = []
  const log = stub(console, "log", (value: string) => output.push(value))
  try {
    await commentDeleteCommand.parse(["comment-id", "--json"])
    assertEquals(JSON.parse(output[0]), {
      ok: true,
      effect: "none",
      data: { id: "comment-id", cancelled: true },
    })
    assertEquals(server.graphqlRequests.length, 0)
  } finally {
    terminal.restore()
    prompt.restore()
    log.restore()
    await cleanup()
  }
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
