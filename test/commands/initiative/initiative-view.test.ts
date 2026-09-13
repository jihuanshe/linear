import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { viewCommand } from "../../../src/commands/initiative/initiative-view.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

await cliffySnapshotTest({
  name: "Initiative View Command - JSON Output",
  meta: import.meta,
  colors: false,
  args: [
    "550e8400-e29b-41d4-a716-446655440000",
    "--json",
    "--include-content",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "ReadInitiative",
        variables: { id: "550e8400-e29b-41d4-a716-446655440000" },
        response: {
          data: {
            organization: { id: "workspace-1", urlKey: "test" },
            initiatives: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                id: "550e8400-e29b-41d4-a716-446655440000",
                slugId: "alpha",
                name: "Alpha Initiative",
                description: "Top-level initiative description.",
                content:
                  "<!-- ai-routing-context:start -->\nroute by project\n<!-- ai-routing-context:end -->",
                status: "active",
                targetDate: "2026-05-01",
                health: "onTrack",
                color: "#10b981",
                icon: "🟢",
                url: "https://linear.app/test/initiative/alpha",
                archivedAt: null,
                createdAt: "2026-01-01T10:00:00Z",
                updatedAt: "2026-02-01T10:00:00Z",
                owner: {
                  id: "owner-1",
                  name: "alex.active",
                  displayName: "Alex Active",
                },
                projects: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "project-1",
                      slugId: "project-a",
                      name: "Project A",
                      description: "Project routing description.",
                      url: "https://linear.app/test/project/project-a",
                      status: {
                        name: "In Progress",
                        type: "started",
                      },
                    },
                  ],
                },
                documents: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{
                    id: "document-1",
                    slugId: "routing-doc",
                    title: "Routing notes",
                    url: "https://linear.app/test/document/routing-doc",
                  }],
                },
              }],
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})
