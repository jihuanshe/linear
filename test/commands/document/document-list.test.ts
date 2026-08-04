import { snapshotTest } from "@cliffy/testing"
import { listCommand } from "../../../src/commands/document/document-list.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

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
