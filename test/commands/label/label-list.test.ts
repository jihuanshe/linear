import { snapshotTest } from "@cliffy/testing"
import { listCommand } from "../../../src/commands/label/label-list.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

await snapshotTest({
  name: "Label List Command - JSON Output",
  meta: import.meta,
  colors: false,
  args: ["--all", "--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueLabels",
        queryIncludes: "groupType",
        variables: { filter: undefined, first: 100, after: undefined },
        response: {
          data: {
            issueLabels: {
              nodes: [
                {
                  id: "label-2",
                  name: "backend",
                  description: "Backend label",
                  color: "#00ff00",
                  isGroup: false,
                  groupType: null,
                  parent: { id: "group-1", name: "Platform" },
                  team: {
                    key: "ENG",
                    name: "Engineering",
                  },
                },
                {
                  id: "label-1",
                  name: "bug",
                  description: "Bug label",
                  color: "#ff0000",
                  isGroup: false,
                  groupType: null,
                  parent: null,
                  team: null,
                },
                {
                  id: "group-1",
                  name: "Platform",
                  description: null,
                  color: "#123456",
                  isGroup: true,
                  groupType: "multiSelect",
                  parent: null,
                  team: { key: "ENG", name: "Engineering" },
                },
                {
                  id: "group-2",
                  name: "Priority",
                  description: null,
                  color: "#654321",
                  isGroup: true,
                  groupType: null,
                  parent: null,
                  team: null,
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
  name: "Label List Command - Empty JSON Output",
  meta: import.meta,
  colors: false,
  args: ["--all", "--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueLabels",
        variables: { filter: undefined, first: 100, after: undefined },
        response: {
          data: {
            issueLabels: {
              nodes: [],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
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

      await listCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})
