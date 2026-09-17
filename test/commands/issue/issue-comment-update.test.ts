import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { commentUpdateCommand } from "../../../src/commands/issue/issue-comment-update.ts"
import { join } from "@std/path"
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

for (const field of ["body", ""]) {
  Deno.test({
    name: `interactive comment dependency preserves basis capture: ${
      JSON.stringify(field)
    }`,
    ignore: Deno.build.os === "windows",
    async fn() {
      const dir = await Deno.makeTempDir()
      const editor = join(dir, "editor")
      const config = join(dir, "gitconfig")
      const seen = join(dir, "seen.md")
      await Deno.writeTextFile(config, "")
      await Deno.writeTextFile(
        editor,
        `#!/bin/sh\ncp "$1" '${seen}'\nprintf '%s' 'New body' > "$1"\n`,
      )
      await Deno.chmod(editor, 0o700)
      const previous = new Map(
        ["EDITOR", "GIT_CONFIG_GLOBAL"].map((key) => [key, Deno.env.get(key)]),
      )
      Deno.env.set("EDITOR", editor)
      Deno.env.set("GIT_CONFIG_GLOBAL", config)
      const { server, cleanup } = await setupMockLinearServer([
        originalComment,
        {
          queryName: "UpdateComment",
          response: {
            data: {
              commentUpdate: {
                success: true,
                comment: {
                  id: "comment-123",
                  body: "New body",
                  url: "https://linear.app/test",
                },
              },
            },
          },
        },
      ])
      const output = stub(console, "log")
      const errors = stub(console, "error")
      const exit = stub(Deno, "exit", () => {
        throw new Error("EXIT")
      })
      try {
        const run = () =>
          commentUpdateCommand.parse([
            "comment-123",
            "--edit",
            "--expect-field",
            field,
          ])
        if (field === "") {
          await assertRejects(run, Error, "EXIT")
          await assertRejects(() => Deno.stat(seen), Deno.errors.NotFound)
          assertEquals(server.graphqlRequests, [])
        } else {
          await run()
          assertEquals(await Deno.readTextFile(seen), "Original body")
          assertEquals(server.graphqlRequests.length, 3)
          assertEquals(server.graphqlRequests[2].variables, {
            id: "comment-123",
            input: { body: "New body" },
          })
        }
      } finally {
        exit.restore()
        errors.restore()
        output.restore()
        for (const [key, value] of previous) {
          if (value == null) Deno.env.delete(key)
          else Deno.env.set(key, value)
        }
        await Deno.remove(dir, { recursive: true })
        await cleanup()
      }
    },
  })
}

for (
  const args of [
    ["--body-file", ""],
    ["--body", "new", "--body-file", ""],
    ["--body", "", "--body-file", "body.md"],
    ["--body", "new", "--base-file", ""],
    ["--body", "new", "--expect-field", ""],
  ]
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
        args.includes("--expect-field")
          ? "--expect-field"
          : args.includes("--base-file")
          ? "file cannot be empty"
          : args.includes("--body")
          ? "both"
          : "path cannot be empty",
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
    "@name is literal log text; \\n stays literal",
    "```",
    "",
    "+++",
    "",
    "段落一  ",
    "软换行",
    "",
    "- 项目",
    "  - 子项目",
    "",
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

Deno.test("Issue Comment Update Command - JSON requires explicit content", async () => {
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
      line.includes("JSON mode requires --body, --body-file, or --attach")
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
