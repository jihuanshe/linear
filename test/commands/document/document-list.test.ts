import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { listCommand } from "../../../src/commands/document/document-list.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

for (const kind of ["UUID", "name", "slug", "unknown"] as const) {
  Deno.test(`document list production entry resolves project ${kind}`, async () => {
    const id = "00000000-0000-0000-0000-000000000000"
    const project = kind === "UUID"
      ? id
      : kind === "slug"
      ? "abc123def456"
      : "Tech Debt"
    const server = new MockLinearServer([
      {
        queryName: "GetProjectIdByName",
        variables: { name: project },
        response: {
          data: { projects: { nodes: kind === "name" ? [{ id }] : [] } },
        },
      },
      {
        queryName: "GetProjectIdBySlugId",
        variables: { slugId: project },
        response: {
          data: { projects: { nodes: kind === "slug" ? [{ id }] : [] } },
        },
      },
      {
        queryName: "ListDocuments",
        variables: { filter: { project: { id: { eq: id } } }, first: 50 },
        response: {
          data: {
            documents: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ])
    try {
      await server.start()
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "document",
          "list",
          "--project",
          project,
          "--json",
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
      assertEquals(result.success, kind !== "unknown", stderr)
      assertEquals(
        server.graphqlRequests.map((request) =>
          request.query.match(/(?:query|mutation)\s+(\w+)/)?.[1]
        ),
        kind === "UUID"
          ? ["ListDocuments"]
          : kind === "name"
          ? ["GetProjectIdByName", "ListDocuments"]
          : kind === "slug"
          ? ["GetProjectIdByName", "GetProjectIdBySlugId", "ListDocuments"]
          : ["GetProjectIdByName", "GetProjectIdBySlugId"],
      )
      if (kind === "unknown") {
        assertEquals(stdout, "")
        assertStringIncludes(stderr, "not found")
        assertStringIncludes(stderr, "Tech Debt")
      } else {
        assertEquals(JSON.parse(stdout), {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        })
      }
    } finally {
      await server.stop()
    }
  })
}

// Test help output
await snapshotTest({
  name: "Document List Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs: commonDenoArgs,
  async fn() {
    listCommand.help({ colors: false })
    await listCommand.parse()
  },
})

// NOTE: Tests for "List All Documents", "Filter By Project", and "Filter By Issue"
// have been removed because they display relative timestamps (e.g., "3 days ago")
// which are inherently non-deterministic. The fakeTime solution causes hangs with
// mock servers (see project-list.test.ts for similar issue).

// Test JSON output (uses raw timestamps, not relative - deterministic)
await snapshotTest({
  name: "Document List Command - JSON Output",
  meta: import.meta,
  colors: false,
  args: ["--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "ListDocuments",
        variables: { first: 50 },
        response: {
          data: {
            documents: {
              nodes: [
                {
                  id: "doc-1",
                  title: "Delegation System Spec",
                  slugId: "d4b93e3b2695",
                  url:
                    "https://linear.app/test/document/delegation-system-spec-d4b93e3b2695",
                  updatedAt: "2026-01-18T10:30:00Z",
                  project: { name: "TinyCloud SDK", slugId: "tinycloud-sdk" },
                  issue: null,
                  creator: { name: "John Doe" },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await listCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test empty results
await snapshotTest({
  name: "Document List Command - Empty Results",
  meta: import.meta,
  colors: false,
  args: [],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "ListDocuments",
        variables: { first: 50 },
        response: {
          data: {
            documents: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await listCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await snapshotTest({
  name: "Document List Command - Filter By Issue JSON Output",
  meta: import.meta,
  colors: false,
  args: ["--issue", "eng-123", "--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueId",
        variables: { id: "ENG-123" },
        response: {
          data: { issue: { id: "issue-uuid" } },
        },
      },
      {
        queryName: "ListDocuments",
        variables: {
          filter: { issue: { id: { eq: "issue-uuid" } } },
          first: 50,
        },
        response: {
          data: {
            documents: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await listCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await snapshotTest({
  name: "Document List Command - Rejects Invalid Limit",
  meta: import.meta,
  colors: false,
  args: ["--limit", "0"],
  denoArgs: commonDenoArgs,
  canFail: true,
  async fn() {
    await listCommand.parse()
  },
})
