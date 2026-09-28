import { assertEquals } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { MockLinearServer } from "../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../utils/test-helpers.ts"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const id = "11111111-1111-4111-8111-111111111111"

// Linear answers a missing object with an error, not with `null` data.
function entityNotFound(type: string) {
  return {
    errors: [{
      message: `Entity not found: ${type}`,
      path: ["entity"],
      extensions: {
        type: "invalid input",
        code: "INPUT_ERROR",
        userPresentableMessage: `Could not find referenced ${type}.`,
      },
    }],
    data: null,
  }
}

for (
  const target of [
    {
      args: ["issue", "comment", "delete", id, "--yes"],
      read: "GetCommentForDelete",
      type: "Comment",
    },
    {
      args: ["project", "delete", id, "--yes"],
      read: "GetProjectForDelete",
      type: "Project",
    },
    {
      args: ["milestone", "delete", id, "--yes"],
      read: "GetMilestoneForDelete",
      type: "ProjectMilestone",
    },
    {
      args: ["issue", "delete", "ENG-404", "--yes"],
      read: "GetIssueDeleteDetails",
      type: "Issue",
    },
    {
      args: ["document", "delete", id, "--yes"],
      read: "GetDocumentForDelete",
      type: "Document",
    },
    {
      args: ["label", "delete", id, "--yes"],
      read: "GetLabelById",
      type: "IssueLabel",
    },
    {
      args: ["initiative", "remove-project", id, id, "--yes"],
      read: "GetInitiativeNameByIdForRemove",
      type: "Initiative",
    },
  ]
) {
  Deno.test(`${target.args.slice(0, -2).join(" ")} reports a missing target as NotFoundError without mutation`, async () => {
    const server = new MockLinearServer([
      {
        queryName: "ReadInitiative",
        response: {
          data: {
            organization: { id: "workspace-1", urlKey: "test" },
            initiatives: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      { queryName: target.read, response: entityNotFound(target.type) },
    ])
    await server.start()
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["run", ...commonDenoArgs, main, ...target.args, "--json"],
        env: {
          LINEAR_API_KEY: "test-token",
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        },
        stdin: "null",
      }).output()
      const output = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(result.code, 1, JSON.stringify(output))
      assertEquals(output.ok, false)
      assertEquals(output.effect, "none")
      assertEquals(output.error.code, "NotFoundError")
      assertEquals(
        server.graphqlRequests.some((request) =>
          /^\s*mutation\b/.test(request.query)
        ),
        false,
      )
    } finally {
      await server.stop()
    }
  })
}
