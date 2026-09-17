import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { createCommand } from "../../../src/commands/document/document-create.ts"
import { Input, Select } from "../../../src/utils/prompt.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const parentProjectId = "11111111-1111-4111-8111-111111111111"
const parentIssueId = "abcdef01-2345-4678-9abc-def012345678"

async function interactiveIssue(reference: string, expectedError?: string) {
  const stdin = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const stdout = stub(
    Object.getPrototypeOf(Deno.stdout),
    "isTerminal",
    () => true,
  )
  const input = stub(Input, "prompt", (options) => {
    if (typeof options === "string") throw new Error("Unexpected prompt")
    if (options.message === "Document title") return Promise.resolve("Spec")
    if (options.message.startsWith("Icon")) return Promise.resolve("")
    assertEquals(
      options.message,
      "Issue (UUID, identifier, or Linear Issue URL)",
    )
    return Promise.resolve(reference)
  })
  const select = stub(Select, "prompt", (options: { message: string }) => {
    if (options.message === "How would you like to enter content?") {
      return Promise.resolve("skip")
    }
    assertEquals(options.message, "Attach document to")
    return Promise.resolve("issue")
  })
  const log = stub(console, "log", () => {})
  const errors: string[] = []
  const stderr = stub(console, "error", (...args: unknown[]) => {
    errors.push(args.join(" "))
  })
  const exit = stub(Deno, "exit", () => {
    throw new Error("EXIT")
  })
  try {
    if (expectedError == null) {
      await createCommand.parse(["--interactive"])
    } else {
      await assertRejects(
        () => createCommand.parse(["--interactive"]),
        Error,
        "EXIT",
      )
      assertStringIncludes(errors.join("\n"), expectedError)
      if (!expectedError.includes("not found")) {
        assertEquals(errors.join("\n").includes("Issue not found"), false)
      }
    }
  } finally {
    exit.restore()
    stderr.restore()
    log.restore()
    select.restore()
    input.restore()
    stdout.restore()
    stdin.restore()
  }
}

for (const interactive of [false, true]) {
  for (
    const scenario of [
      {
        name: "UUID",
        reference: parentIssueId.toUpperCase(),
        resolved: parentIssueId,
      },
      { name: "identifier", reference: "eng-123", resolved: "ENG-123" },
      {
        name: "URL",
        reference: "https://linear.app/test/issue/ENG-123/title",
        resolved: "ENG-123",
      },
      { name: "empty", reference: "", error: "Invalid issue reference" },
      { name: "blank", reference: " ", error: "Invalid issue reference" },
      {
        name: "branch",
        reference: "feature/ENG-123",
        error: "Invalid issue reference",
      },
      {
        name: "invalid URL",
        reference: "https://example.com/test/issue/ENG-123",
        error: "Invalid issue reference",
      },
      {
        name: "cross-workspace",
        reference: "https://linear.app/other/issue/ENG-123/title",
        error: "different workspace",
      },
      {
        name: "missing",
        reference: "ENG-123",
        resolved: "ENG-123",
        error: "Issue not found",
      },
      {
        name: "unauthorized",
        reference: "ENG-123",
        resolved: "ENG-123",
        error: "Issue lookup unauthorized",
        status: 401,
      },
      {
        name: "unavailable",
        reference: "ENG-123",
        resolved: "ENG-123",
        error: "Issue lookup unavailable",
        status: 503,
      },
      {
        name: "workspace unauthorized",
        reference: "https://linear.app/test/issue/ENG-123/title",
        error: "Workspace lookup unauthorized",
        status: 401,
      },
    ]
  ) {
    Deno.test(`document create Issue reference ${scenario.name}: interactive=${interactive}`, async () => {
      const { server, cleanup } = await setupMockLinearServer([
        {
          queryName: "GetIssueReferenceWorkspace",
          status: scenario.name === "workspace unauthorized" ? 401 : 200,
          response: scenario.name === "workspace unauthorized"
            ? { errors: [{ message: scenario.error }] }
            : { data: { organization: { id: "workspace", urlKey: "test" } } },
        },
        {
          queryName: "GetIssueId",
          variables: { id: scenario.resolved },
          status: scenario.status ?? 200,
          response: scenario.status != null
            ? { errors: [{ message: scenario.error }] }
            : {
              data: {
                issue: scenario.name === "missing"
                  ? null
                  : { id: parentIssueId },
              },
            },
        },
        {
          queryName: "CreateDocument",
          response: {
            data: {
              documentCreate: {
                success: true,
                document: {
                  id: "document",
                  title: "Spec",
                  url: "https://linear.app/test/document/spec",
                },
              },
            },
          },
        },
      ])
      try {
        if (interactive) {
          await interactiveIssue(scenario.reference, scenario.error)
        } else {
          const result = await new Deno.Command(Deno.execPath(), {
            args: [
              "run",
              ...commonDenoArgs,
              "src/main.ts",
              "document",
              "create",
              "--title",
              "Spec",
              "--content",
              "",
              "--issue",
              scenario.reference,
              "--json",
            ],
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
          }).output()
          const body = JSON.parse(new TextDecoder().decode(result.stdout))
          assertEquals(
            result.code,
            scenario.error == null ? 0 : 1,
            JSON.stringify(body),
          )
          assertEquals(body.effect, scenario.error == null ? "applied" : "none")
          if (scenario.error != null) {
            assertStringIncludes(body.error.message, scenario.error)
            if (!scenario.error.includes("not found")) {
              assertEquals(body.error.code === "NotFoundError", false)
            }
          }
          assertEquals(result.stderr.length, 0)
        }
        const lookups = server.graphqlRequests.filter((request) =>
          request.query.includes("query GetIssueId")
        )
        assertEquals(
          lookups.map((request) => request.variables),
          scenario.resolved == null ? [] : [{ id: scenario.resolved }],
        )
        const writes = server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        )
        assertEquals(writes.length, scenario.error == null ? 1 : 0)
        if (scenario.error == null) {
          assertEquals(writes[0].variables.input, {
            title: "Spec",
            issueId: parentIssueId,
            ...(interactive ? {} : { content: "" }),
          })
        }
        if (
          ["empty", "blank", "branch", "invalid URL"].includes(scenario.name)
        ) {
          assertEquals(server.graphqlRequests, [])
        }
      } finally {
        await cleanup()
      }
    })
  }
}

Deno.test("document create preserves transport failure instead of Issue not found", async () => {
  const code = `
    import { cli } from "./src/cli.ts";
    globalThis.fetch = () => { throw new TypeError("transport offline"); };
    await cli.parse(["document", "create", "--title", "Spec", "--content", "", "--issue", "ENG-123", "--json"]);
  `
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--quiet", code],
    env: { LINEAR_API_KEY: "test-token" },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output()
  const body = JSON.parse(new TextDecoder().decode(result.stdout))
  assertEquals(result.code, 1)
  assertEquals(body.effect, "none")
  assertStringIncludes(body.error.message, "transport offline")
  assertEquals(body.error.code === "NotFoundError", false)
})

for (
  const parents of [
    [],
    ["--project", parentProjectId, "--issue", "ENG-123"],
  ]
) {
  Deno.test(`document create requires exactly one parent: ${parents.length / 2}`, async () => {
    const server = new MockLinearServer([])
    try {
      await server.start()
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "document",
          "create",
          "--title",
          "Document",
          ...parents,
          "--json",
        ],
        env: {
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          LINEAR_API_KEY: "test-token",
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const body = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(result.code, 1)
      assertEquals(body.effect, "none")
      assertStringIncludes(body.error.message, "Exactly one")
      assertEquals(server.graphqlRequests, [])
    } finally {
      await server.stop()
    }
  })
}

for (
  const args of [
    ["--content", ""],
    ["--content="],
    ["-c", ""],
    ["--content-file", ""],
    ["--content", "", "--content-file", ""],
    ["--content", "new", "--content-file", ""],
  ]
) {
  Deno.test(`explicit empty input: document create ${JSON.stringify(args)}`, async () => {
    const invalid = args.includes("--content-file")
    const server = new MockLinearServer([{
      queryName: "CreateDocument",
      variables: {
        input: { title: "Spec", content: "", projectId: parentProjectId },
      },
      response: {
        data: {
          documentCreate: {
            success: true,
            document: {
              id: "doc-1",
              title: "Spec",
              url: "https://linear.app/test",
            },
          },
        },
      },
    }])
    try {
      await server.start()
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "document",
          "create",
          "--title",
          "Spec",
          "--project",
          parentProjectId,
          "--json",
          ...args,
        ],
        env: {
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          LINEAR_API_KEY: "test-token",
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn()
      const writer = child.stdin.getWriter()
      await writer.write(new TextEncoder().encode("Must not become content"))
      await writer.close()
      const result = await child.output()
      const body = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(result.code, invalid ? 1 : 0, JSON.stringify(body))
      assertEquals(server.graphqlRequests.length, invalid ? 0 : 1)
      if (invalid) {
        assertEquals(body.effect, "none")
        assertStringIncludes(
          body.error.message,
          args.includes("--content") ? "both" : "empty",
        )
      } else {
        assertEquals(server.graphqlRequests[0].variables, {
          input: { title: "Spec", content: "", projectId: parentProjectId },
        })
      }
    } finally {
      await server.stop()
    }
  })
}

// Test help output
await snapshotTest({
  name: "Document Create Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs: commonDenoArgs,
  async fn() {
    createCommand.help({ colors: false })
    await createCommand.parse()
  },
})

// Test creating a document with inline content
await snapshotTest({
  name: "Document Create Command - With Inline Content",
  meta: import.meta,
  colors: false,
  args: [
    "--title",
    "Test Document",
    "--project",
    parentProjectId,
    "--content",
    "# Hello\n\nWorld",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "CreateDocument",
        variables: {
          input: {
            title: "Test Document",
            content: "# Hello\n\nWorld",
            projectId: parentProjectId,
          },
        },
        response: {
          data: {
            documentCreate: {
              success: true,
              document: {
                id: "doc-new",
                slugId: "newd0c12345",
                title: "Test Document",
                url:
                  "https://linear.app/test/document/test-document-newd0c12345",
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test creating a document attached to a project
await snapshotTest({
  name: "Document Create Command - Attached To Project",
  meta: import.meta,
  colors: false,
  args: [
    "--title",
    "Project Spec",
    "--project",
    "tinycloud-sdk",
    "--content",
    "# Spec",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      // Shared project resolver tries name first, then slugId
      {
        queryName: "GetProjectIdByName",
        response: {
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      },
      {
        queryName: "GetProjectIdBySlugId",
        variables: { slugId: "tinycloud-sdk" },
        response: {
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "project-uuid-123" }],
            },
          },
        },
      },
      // Mock document create mutation
      {
        queryName: "CreateDocument",
        response: {
          data: {
            documentCreate: {
              success: true,
              document: {
                id: "doc-proj",
                slugId: "projd0c456",
                title: "Project Spec",
                url: "https://linear.app/test/document/project-spec-projd0c456",
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test creating a document attached to an issue
await snapshotTest({
  name: "Document Create Command - Attached To Issue",
  meta: import.meta,
  colors: false,
  args: [
    "--title",
    "Investigation",
    "--issue",
    "TC-123",
    "--content",
    "# Notes",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      // Mock issue resolution query
      {
        queryName: "GetIssueId",
        variables: { id: "TC-123" },
        response: {
          data: {
            issue: {
              id: "issue-uuid-456",
              identifier: "TC-123",
            },
          },
        },
      },
      // Mock document create mutation
      {
        queryName: "CreateDocument",
        response: {
          data: {
            documentCreate: {
              success: true,
              document: {
                id: "doc-issue",
                slugId: "issued0c789",
                title: "Investigation",
                url:
                  "https://linear.app/test/document/investigation-issued0c789",
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test creating a document with icon
await snapshotTest({
  name: "Document Create Command - With Icon",
  meta: import.meta,
  colors: false,
  args: [
    "--title",
    "Design Doc",
    "--project",
    parentProjectId,
    "--icon",
    "📐",
    "--content",
    "# Design",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "CreateDocument",
        variables: {
          input: {
            title: "Design Doc",
            content: "# Design",
            icon: "📐",
            projectId: parentProjectId,
          },
        },
        response: {
          data: {
            documentCreate: {
              success: true,
              document: {
                id: "doc-icon",
                slugId: "icond0c000",
                title: "Design Doc",
                url: "https://linear.app/test/document/design-doc-icond0c000",
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test missing title error
await snapshotTest({
  name: "Document Create Command - Missing Title Error",
  meta: import.meta,
  colors: false,
  canFail: true,
  args: ["--content", "# Content without title"],
  denoArgs: commonDenoArgs,
  async fn() {
    // Set dummy API key so validation logic is reached (not "api_key not set" error)
    Deno.env.set("LINEAR_API_KEY", "dummy-key-for-validation-test")
    try {
      await createCommand.parse()
    } finally {
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// NOTE: "API Error" test removed - stack traces contain machine-specific paths
