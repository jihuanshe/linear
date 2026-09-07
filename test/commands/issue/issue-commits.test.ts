import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { commitsCommand } from "../../../src/commands/issue/issue-commits.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

// Common Deno args for permissions
const denoArgs = ["--allow-all", "--quiet"]

// Test help output
await snapshotTest({
  name: "Issue Commits Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs,
  async fn() {
    commitsCommand.help({ colors: false })
    await commitsCommand.parse()
  },
})

for (const outcome of ["found", "empty", "error"] as const) {
  Deno.test(`issue commits uses a bounded jj revset: ${outcome}`, async () => {
    const { cleanup } = await setupMockLinearServer([{
      queryName: "GetIssueId",
      variables: { id: "FXA-1" },
      response: { data: { issue: { id: "issue-uuid" } } },
    }])
    const previousVcs = Deno.env.get("LINEAR_VCS")
    Deno.env.set("LINEAR_VCS", "jj")
    const calls: Deno.CommandOptions[] = []
    const exits: number[] = []
    const errors: string[] = []
    const command = Object.getOwnPropertyDescriptor(Deno, "Command")!
    Object.defineProperty(Deno, "Command", {
      configurable: true,
      value: class extends Deno.Command {
        constructor(...args: ConstructorParameters<typeof Deno.Command>) {
          super(...args)
          assertEquals(args[0], "jj")
          calls.push(args[1]!)
        }
        override output(): Promise<Deno.CommandOutput> {
          const code = outcome === "error" ? 2 : 0
          return Promise.resolve({
            code,
            success: code === 0,
            signal: null,
            stdout: new TextEncoder().encode(
              outcome === "found" ? "commit-id" : "",
            ),
            stderr: new TextEncoder().encode(
              outcome === "error" ? "jj repository unavailable" : "",
            ),
          })
        }
      },
    })
    const exit = stub(Deno, "exit", (code?: number): never => {
      exits.push(code ?? 0)
      return undefined as never
    })
    const error = stub(console, "error", (...args: unknown[]) => {
      errors.push(args.join(" "))
    })
    try {
      await commitsCommand.parse(["fxa-1"])
      const revset = 'description(regex:"(?m)^Linear-issue:.*\\\\bFXA-1\\\\b")'
      assertEquals(calls[0].args, [
        "log",
        "-r",
        revset,
        "-T",
        "commit_id",
        "--no-graph",
      ])
      assertEquals(calls.length, outcome === "found" ? 2 : 1)
      assertEquals(exits, [outcome === "found" ? 0 : 1])
      if (outcome === "found") {
        assertEquals(calls[1].args, [
          "log",
          "-r",
          revset,
          "-p",
          "--git",
          "--no-graph",
          "-T",
          "builtin_log_compact_full_description",
        ])
        assertEquals(errors, [])
      } else {
        assertStringIncludes(
          errors.join("\n"),
          outcome === "error"
            ? "Failed to query jj commits"
            : "Commits not found",
        )
        if (outcome === "error") {
          assertStringIncludes(errors.join("\n"), "jj repository unavailable")
        }
      }
    } finally {
      error.restore()
      exit.restore()
      Object.defineProperty(Deno, "Command", command)
      if (previousVcs == null) Deno.env.delete("LINEAR_VCS")
      else Deno.env.set("LINEAR_VCS", previousVcs)
      await cleanup()
    }
  })
}
