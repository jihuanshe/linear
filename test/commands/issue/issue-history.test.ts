import { snapshotTest } from "@cliffy/testing"
import { historyCommand } from "../../../src/commands/issue/issue-history.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

const denoArgs = ["--allow-all", "--quiet"]

await snapshotTest({
  name: "Issue History Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs,
  async fn() {
    historyCommand.help({ colors: false })
    await historyCommand.parse()
  },
})

await snapshotTest({
  name: "Issue History Command - JSON",
  meta: import.meta,
  colors: false,
  args: ["TEST-123", "--json"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueHistory",
        variables: { id: "TEST-123" },
        response: {
          data: {
            issue: {
              identifier: "TEST-123",
              history: {
                nodes: [
                  {
                    createdAt: "2026-09-05T00:00:00Z",
                    actor: { name: "alex", displayName: "Alex" },
                    botActor: null,
                    fromProject: { name: "Old" },
                    toProject: { name: "New" },
                    fromAssignee: null,
                    toAssignee: null,
                    fromState: null,
                    toState: null,
                    changes: null,
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    ])

    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    try {
      await historyCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})
