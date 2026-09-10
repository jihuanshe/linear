import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { updateCommand } from "../../../src/commands/document/document-update.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

for (const option of ["--title", "--icon", "--project"]) {
  for (const value of ["", " \n"]) {
    Deno.test(`document rejects invalid metadata: ${option} ${JSON.stringify(value)}`, async () => {
      const server = new MockLinearServer([])
      try {
        await server.start()
        const result = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            ...commonDenoArgs,
            "src/main.ts",
            "document",
            "update",
            "doc-1",
            option,
            value,
            "--content",
            "Must not be written",
            "--unprotected",
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
        assertStringIncludes(body.error.message, `${option} cannot be empty`)
        assertEquals(server.graphqlRequests, [])
      } finally {
        await server.stop()
      }
    })
  }
}

for (
  const command of [
    ["document", "update", "doc-1", "--title", "New"],
    ["issue", "comment", "update", "comment-1", "--body", "New"],
    ["issue", "update", "ENG-123", "--title", "New"],
    ["project", "update", "project-1", "--name", "New"],
    ["initiative", "update", "initiative-1", "--name", "New"],
    ["milestone", "update", "milestone-1", "--name", "New"],
  ]
) {
  Deno.test(`explicit empty input: ${command.slice(0, -2).join(" ")} base file`, async () => {
    const server = new MockLinearServer([])
    try {
      await server.start()
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          ...command,
          "--base-file",
          "",
          "--unprotected",
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
      assertStringIncludes(body.error.message, "empty")
      assertEquals(server.graphqlRequests, [])
    } finally {
      await server.stop()
    }
  })
}

const originalDocument = {
  queryName: "ReadDocument",
  response: {
    data: {
      organization: { id: "workspace-1", urlKey: "test" },
      document: {
        id: "doc-1",
        title: "Original title",
        content: "Old content",
        icon: null,
        project: null,
        archivedAt: null,
      },
    },
  },
}

for (
  const scenario of [
    "clear",
    "inline",
    "equals",
    "short",
    "blocked",
    "nonempty",
    "title",
    "unchanged",
    "null",
    "read-error",
  ] as const
) {
  Deno.test(`document update production entry empty content: ${scenario}`, async () => {
    const file = await Deno.makeTempFile()
    const content = scenario === "nonempty" ? " \n# Keep whitespace\n\n " : ""
    const verifiesClear = !["blocked", "nonempty", "title"].includes(scenario)
    const succeeds = ["clear", "inline", "equals", "short", "nonempty", "title"]
      .includes(scenario)
    const server = new MockLinearServer([
      {
        queryName: "ReadDocument",
        response: (_request, history) => {
          if (
            !history.some((request) =>
              request.query.includes("mutation UpdateDocument")
            )
          ) return originalDocument.response
          if (scenario === "read-error") {
            return { errors: [{ message: "Read denied" }] }
          }
          return {
            data: {
              organization: { id: "workspace-1", urlKey: "test" },
              document: {
                id: "doc-1",
                title: "Spec",
                icon: null,
                project: null,
                archivedAt: null,
                content: scenario === "unchanged"
                  ? "Old content"
                  : scenario === "null"
                  ? null
                  : "",
              },
            },
          }
        },
      },
      {
        queryName: "DocumentInlineCommentGuard",
        response: {
          data: {
            document: {
              id: "doc-1",
              comments: {
                nodes: scenario === "blocked"
                  ? [{
                    id: "comment-1",
                    quotedText: "Keep",
                    resolvedAt: null,
                    archivedAt: null,
                  }]
                  : [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
      {
        queryName: "UpdateDocument",
        variables: {
          id: "doc-1",
          input: scenario === "title"
            ? { title: "Spec" }
            : { content: content === "" ? "\n" : content },
        },
        response: {
          data: {
            documentUpdate: {
              success: true,
              document: {
                id: "doc-1",
                slugId: "slug",
                title: "Spec",
                url: "https://linear.app/test/document/spec",
                updatedAt: "2026-01-19T10:00:00Z",
              },
            },
          },
        },
      },
    ])
    try {
      await Deno.writeTextFile(file, content)
      await server.start()
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "document",
          "update",
          "doc-1",
          "--unprotected",
          ...(scenario === "title"
            ? ["--title", "Spec"]
            : scenario === "inline"
            ? ["--content", ""]
            : scenario === "equals"
            ? ["--content="]
            : scenario === "short"
            ? ["-c", ""]
            : ["--content-file", file]),
        ],
        env: {
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          LINEAR_API_KEY: "test-token",
          NO_COLOR: "1",
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const stdout = new TextDecoder().decode(result.stdout)
      const stderr = new TextDecoder().decode(result.stderr)
      assertEquals(result.success, succeeds, stderr)
      assertEquals(
        server.graphqlRequests.map((request) =>
          request.query.match(/(?:query|mutation)\s+(\w+)/)?.[1]
        ),
        [
          "ReadDocument",
          ...(scenario === "title" ? [] : ["DocumentInlineCommentGuard"]),
          ...(["title", "blocked"].includes(scenario) ? [] : ["ReadDocument"]),
          ...(scenario === "blocked" ? [] : ["UpdateDocument"]),
          ...(verifiesClear ? ["ReadDocument"] : []),
        ],
      )
      if (succeeds) {
        assertStringIncludes(stdout, "✓ Updated document: Spec")
      } else {
        assertEquals(stdout, "")
        assertStringIncludes(
          stderr,
          scenario === "blocked" ? "inline comments" : "update was applied",
        )
        if (verifiesClear) {
          assertStringIncludes(stderr, "Inspect the document before retrying")
        }
      }
    } finally {
      await server.stop()
      await Deno.remove(file)
    }
  })
}

Deno.test("document update rejects empty paths and competing content sources without requests", async () => {
  for (
    const args of [
      ["--content-file="],
      ["--content-file", ""],
      ["--content", "", "--content-file", ""],
      ["--content=", "--edit"],
      ["--content-file", "unused.md", "--edit"],
    ]
  ) {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        ...commonDenoArgs,
        "--deny-net",
        "src/main.ts",
        "document",
        "update",
        "doc-1",
        "--unprotected",
        ...args,
      ],
      env: { NO_COLOR: "1" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(result.code, 1)
    assertEquals(new TextDecoder().decode(result.stdout), "")
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      args.length <= 2 && !args.includes("--edit")
        ? "Content file path cannot be empty"
        : "Use only one of --content, --content-file, or --edit",
    )
  }
})

// Test help output
await snapshotTest({
  name: "Document Update Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs: commonDenoArgs,
  async fn() {
    updateCommand.help({ colors: false })
    await updateCommand.parse()
  },
})

// Test updating document title
await snapshotTest({
  name: "Document Update Command - Update Title",
  meta: import.meta,
  colors: false,
  args: ["--unprotected", "d4b93e3b2695", "--title", "New Title"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "UpdateDocument",
      variables: {
        id: "doc-1",
        input: {
          title: "New Title",
        },
      },
      response: {
        data: {
          documentUpdate: {
            success: true,
            document: {
              id: "doc-1",
              slugId: "d4b93e3b2695",
              title: "New Title",
              url: "https://linear.app/test/document/new-title-d4b93e3b2695",
              updatedAt: "2026-01-19T10:00:00Z",
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test updating document content
await snapshotTest({
  name: "Document Update Command - Update Content",
  meta: import.meta,
  colors: false,
  args: [
    "--unprotected",
    "d4b93e3b2695",
    "--content",
    "# Updated Content\n\nNew content here.",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "DocumentInlineCommentGuard",
      variables: {
        id: "doc-1",
        after: null,
      },
      response: {
        data: {
          document: {
            id: "doc-1",
            title: "Delegation System Spec",
            content: "# Current Content",
            comments: {
              nodes: [],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        },
      },
    }, {
      queryName: "UpdateDocument",
      variables: {
        id: "doc-1",
        input: {
          content: "# Updated Content\n\nNew content here.",
        },
      },
      response: {
        data: {
          documentUpdate: {
            success: true,
            document: {
              id: "doc-1",
              slugId: "d4b93e3b2695",
              title: "Delegation System Spec",
              url:
                "https://linear.app/test/document/delegation-system-spec-d4b93e3b2695",
              updatedAt: "2026-01-19T10:00:00Z",
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test content updates allow top-level document comments without inline anchors
await snapshotTest({
  name:
    "Document Update Command - Allows Content Update With Top Level Comments",
  meta: import.meta,
  colors: false,
  args: ["--unprotected", "d4b93e3b2695", "--content", "# Updated Content"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "DocumentInlineCommentGuard",
      variables: {
        id: "doc-1",
        after: null,
      },
      response: {
        data: {
          document: {
            id: "doc-1",
            comments: {
              nodes: [
                {
                  id: "comment-1",
                  quotedText: null,
                },
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        },
      },
    }, {
      queryName: "UpdateDocument",
      variables: {
        id: "doc-1",
        input: {
          content: "# Updated Content",
        },
      },
      response: {
        data: {
          documentUpdate: {
            success: true,
            document: {
              id: "doc-1",
              slugId: "d4b93e3b2695",
              title: "Delegation System Spec",
              url:
                "https://linear.app/test/document/delegation-system-spec-d4b93e3b2695",
              updatedAt: "2026-01-19T10:00:00Z",
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test content updates refuse to run when inline document comments exist
await snapshotTest({
  name: "Document Update Command - Blocks Content Update With Inline Comments",
  meta: import.meta,
  colors: false,
  canFail: true,
  args: ["--unprotected", "d4b93e3b2695", "--content", "# Updated Content"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "DocumentInlineCommentGuard",
      variables: {
        id: "doc-1",
        after: null,
      },
      response: {
        data: {
          document: {
            id: "doc-1",
            title: "Delegation System Spec",
            content: "# Current Content",
            comments: {
              nodes: [
                {
                  id: "comment-1",
                  quotedText: null,
                },
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
              },
            },
          },
        },
      },
    }, {
      queryName: "DocumentInlineCommentGuard",
      variables: {
        id: "doc-1",
        after: "cursor-1",
      },
      response: {
        data: {
          document: {
            id: "doc-1",
            comments: {
              nodes: [
                {
                  id: "comment-2",
                  quotedText: "Current Content",
                },
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test --force bypasses the comment guard for intentional content replacement
await snapshotTest({
  name: "Document Update Command - Force Content Update With Comments",
  meta: import.meta,
  colors: false,
  args: [
    "--unprotected",
    "d4b93e3b2695",
    "--content",
    "# Updated Content",
    "--force",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "UpdateDocument",
      variables: {
        id: "doc-1",
        input: {
          content: "# Updated Content",
        },
      },
      response: {
        data: {
          documentUpdate: {
            success: true,
            document: {
              id: "doc-1",
              slugId: "d4b93e3b2695",
              title: "Delegation System Spec",
              url:
                "https://linear.app/test/document/delegation-system-spec-d4b93e3b2695",
              updatedAt: "2026-01-19T10:00:00Z",
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test updating multiple fields
await snapshotTest({
  name: "Document Update Command - Update Multiple Fields",
  meta: import.meta,
  colors: false,
  args: [
    "--unprotected",
    "d4b93e3b2695",
    "--title",
    "Updated Title",
    "--content",
    "# New Content",
    "--icon",
    "📝",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "DocumentInlineCommentGuard",
      variables: {
        id: "doc-1",
        after: null,
      },
      response: {
        data: {
          document: {
            id: "doc-1",
            title: "Delegation System Spec",
            content: "# Current Content",
            comments: {
              nodes: [],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        },
      },
    }, {
      queryName: "UpdateDocument",
      variables: {
        id: "doc-1",
        input: {
          title: "Updated Title",
          content: "# New Content",
          icon: "📝",
        },
      },
      response: {
        data: {
          documentUpdate: {
            success: true,
            document: {
              id: "doc-1",
              slugId: "d4b93e3b2695",
              title: "Updated Title",
              url:
                "https://linear.app/test/document/updated-title-d4b93e3b2695",
              updatedAt: "2026-01-19T10:00:00Z",
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// NOTE: "Document Not Found" test removed - stack traces contain machine-specific paths

// Test no update fields provided
await snapshotTest({
  name: "Document Update Command - No Fields Provided",
  meta: import.meta,
  colors: false,
  canFail: true,
  args: ["--unprotected", "d4b93e3b2695"],
  denoArgs: commonDenoArgs,
  async fn() {
    // Set dummy API key so validation logic is reached (not "api_key not set" error)
    Deno.env.set("LINEAR_API_KEY", "dummy-key-for-validation-test")
    try {
      await updateCommand.parse()
    } finally {
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// NOTE: "Permission Error" test removed - stack traces contain machine-specific paths

// A RESOLVED inline comment (closed thread) must NOT block a content update:
// detaching the anchor of a resolved comment loses no live context, so the
// guard should let the update through without --force.
await snapshotTest({
  name: "Document Update Command - Resolved Inline Comment Does Not Block",
  meta: import.meta,
  colors: false,
  args: ["--unprotected", "d4b93e3b2695", "--content", "# Updated Content"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "DocumentInlineCommentGuard",
      variables: { id: "doc-1" },
      response: {
        data: {
          document: {
            id: "doc-1",
            comments: {
              nodes: [
                {
                  // Inline (has quotedText) but resolved: must be ignored.
                  id: "comment-resolved",
                  quotedText: "Old anchored text",
                  resolvedAt: "2026-01-15T10:00:00Z",
                  archivedAt: null,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }, {
      queryName: "UpdateDocument",
      variables: {
        id: "doc-1",
        input: { content: "# Updated Content" },
      },
      response: {
        data: {
          documentUpdate: {
            success: true,
            document: {
              id: "doc-1",
              slugId: "d4b93e3b2695",
              title: "Delegation System Spec",
              url:
                "https://linear.app/test/document/delegation-system-spec-d4b93e3b2695",
              updatedAt: "2026-01-19T10:00:00Z",
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Regression tests for #225: `document update` can set, change, or clear the
// document's related project (previously only settable at create time).

const projectDocResponse = {
  data: {
    documentUpdate: {
      success: true,
      document: {
        id: "doc-1",
        slugId: "d4b93e3b2695",
        title: "Spec",
        url: "https://linear.app/test/document/spec-d4b93e3b2695",
        updatedAt: "2026-01-19T10:00:00Z",
      },
    },
  },
}

// Set the project by UUID — resolveProjectId short-circuits, so the only query
// is the update mutation carrying the resolved projectId.
await snapshotTest({
  name: "Document Update Command - Set Project By UUID",
  meta: import.meta,
  colors: false,
  args: [
    "--unprotected",
    "d4b93e3b2695",
    "--project",
    "00000000-0000-0000-0000-000000000000",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "UpdateDocument",
      variables: {
        id: "doc-1",
        input: { projectId: "00000000-0000-0000-0000-000000000000" },
      },
      response: projectDocResponse,
    }])
    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Set the project by name — resolveProjectId looks it up, then the update runs.
await snapshotTest({
  name: "Document Update Command - Set Project By Name",
  meta: import.meta,
  colors: false,
  args: ["--unprotected", "d4b93e3b2695", "--project", "Tech Debt"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "GetProjectIdByName",
      variables: { name: "Tech Debt" },
      response: {
        data: {
          projects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "proj-uuid" }],
          },
        },
      },
    }, {
      queryName: "UpdateDocument",
      variables: {
        id: "doc-1",
        input: { projectId: "proj-uuid" },
      },
      response: projectDocResponse,
    }])
    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Combining a project change with another field updates both in one mutation.
await snapshotTest({
  name: "Document Update Command - Title And Project",
  meta: import.meta,
  colors: false,
  args: [
    "--unprotected",
    "d4b93e3b2695",
    "--title",
    "Renamed Spec",
    "--project",
    "00000000-0000-0000-0000-000000000000",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "UpdateDocument",
      variables: {
        id: "doc-1",
        input: {
          title: "Renamed Spec",
          projectId: "00000000-0000-0000-0000-000000000000",
        },
      },
      response: projectDocResponse,
    }])
    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// An unknown project name fails with the standard not-found error and no update.
await snapshotTest({
  name: "Document Update Command - Project Not Found",
  meta: import.meta,
  colors: false,
  args: ["--unprotected", "d4b93e3b2695", "--project", "Nope"],
  denoArgs: commonDenoArgs,
  canFail: true,
  async fn() {
    const server = new MockLinearServer([originalDocument, {
      queryName: "GetProjectIdByName",
      variables: { name: "Nope" },
      response: {
        data: {
          projects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    }, {
      queryName: "GetProjectIdBySlugId",
      variables: { slugId: "Nope" },
      response: {
        data: {
          projects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    }])
    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})
