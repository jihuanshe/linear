import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { createCommand } from "../../../src/commands/document/document-create.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

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
      variables: { input: { title: "Spec", content: "" } },
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
      assertEquals(result.code, invalid ? 1 : 0)
      assertEquals(server.graphqlRequests.length, invalid ? 0 : 1)
      if (invalid) {
        assertEquals(body.effect, "none")
        assertStringIncludes(
          body.error.message,
          args.includes("--content") ? "either" : "empty",
        )
      } else {
        assertEquals(server.graphqlRequests[0].variables, {
          input: { title: "Spec", content: "" },
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
  args: ["--title", "Test Document", "--content", "# Hello\n\nWorld"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "CreateDocument",
        variables: {
          input: {
            title: "Test Document",
            content: "# Hello\n\nWorld",
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
        queryName: "GetIssueForDocument",
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
  args: ["--title", "Design Doc", "--icon", "📐", "--content", "# Design"],
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
