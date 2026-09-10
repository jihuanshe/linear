import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { commentUpdateCommand } from "../../../src/commands/issue/issue-comment-update.ts"
import type { MockGraphQLRequest } from "../../utils/mock_linear_server.ts"

const originalComment = {
  queryName: "ReadComment",
  response: ({ variables }: MockGraphQLRequest) => ({
    data: {
      organization: { id: "workspace-1", urlKey: "test" },
      comment: { id: variables.id, body: "Original body", archivedAt: null },
    },
  }),
}
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

for (
  const args of [["--body-file", ""], ["--body", "new", "--body-file", ""]]
) {
  Deno.test(`explicit empty input: comment ${JSON.stringify(args)}`, async () => {
    const { server, cleanup } = await setupMockLinearServer([])
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "issue",
          "comment",
          "update",
          "comment-1",
          "--json",
          "--unprotected",
          ...args,
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const body = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(result.code, 1)
      assertEquals(body.effect, "none")
      assertStringIncludes(
        body.error.message,
        args.includes("--body") ? "both" : "path cannot be empty",
      )
      assertEquals(server.graphqlRequests, [])
    } finally {
      await cleanup()
    }
  })
}

for (const input of ["empty", "whitespace", "file"] as const) {
  Deno.test(`comment update JSON distinguishes explicit ${input} content from an omitted body`, async () => {
    const { server, cleanup } = await setupMockLinearServer([])
    const path = await Deno.makeTempFile({ suffix: ".md" })
    try {
      const args = input === "file"
        ? ["--body-file", path]
        : ["--body", input === "empty" ? "" : " \n"]
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "issue",
          "comment",
          "update",
          "comment-123",
          "--unprotected",
          "--json",
          ...args,
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const body = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(result.code, 1)
      assertEquals(body.effect, "none")
      assertEquals(
        body.error.message,
        "Failed to update comment: Comment body cannot be empty",
      )
      assertEquals(new TextDecoder().decode(result.stderr), "")
      assertEquals(server.graphqlRequests, [])
    } finally {
      await Deno.remove(path)
      await cleanup()
    }
  })
}

Deno.test("comment update preserves mentions, ordinary links and collapsible Markdown", async () => {
  const body = [
    "https://linear.app/example/profiles/person-123 请确认。",
    "[普通链接](https://linear.app/example/profiles/person-456)",
    "+++ [日志]",
    "",
    "```text",
    "@name is literal log text",
    "```",
    "",
    "+++",
  ].join("\n")
  const { server, cleanup } = await setupMockLinearServer([originalComment, {
    queryName: "UpdateComment",
    response: {
      data: {
        commentUpdate: {
          success: true,
          comment: {
            id: "comment-123",
            body,
            url: "https://linear.app/example",
          },
        },
      },
    },
  }])
  const path = await Deno.makeTempFile({ suffix: ".md" })
  const output = stub(console, "log")
  try {
    await Deno.writeTextFile(path, body)
    for (const input of [["--body", body], ["--body-file", path]]) {
      await commentUpdateCommand.parse([
        "--unprotected",
        "comment-123",
        ...input,
        "--json",
      ])
    }
    const mutations = server.graphqlRequests.filter((request) =>
      request.query.includes("mutation UpdateComment")
    )
    assertEquals(mutations.length, 2)
    for (const request of mutations) {
      assertEquals(request.variables, { id: "comment-123", input: { body } })
    }
  } finally {
    output.restore()
    await Deno.remove(path)
    await cleanup()
  }
})

// Test updating a comment with body flag
await snapshotTest({
  name: "Issue Comment Update Command - With Body Flag",
  meta: import.meta,
  colors: false,
  args: [
    "--unprotected",
    "comment-uuid-123",
    "--body",
    "This is the updated comment text",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([originalComment, {
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
    }])

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
    await commentUpdateCommand.parse([
      "--unprotected",
      "comment-uuid-123",
      "--json",
    ])
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
  args: [
    "--unprotected",
    "comment-uuid-123",
    "--body",
    "Updated as JSON",
    "--json",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([originalComment, {
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
    }])

    try {
      await commentUpdateCommand.parse()
    } finally {
      await cleanup()
    }
  },
})
