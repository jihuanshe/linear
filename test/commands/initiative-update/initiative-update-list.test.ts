import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { listCommand } from "../../../src/commands/initiative-update/initiative-update-list.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

for (
  const scenario of [
    "slug",
    "name",
    "ambiguous-slug",
    "ambiguous-name",
    "more-pages",
    "read-failure",
    "missing",
    "UUID",
  ]
) {
  Deno.test(`initiative update list strict resolution: ${scenario}`, async () => {
    const id = "abcdef01-2345-4678-9abc-def012345678"
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "FindInitiative",
        response: ({ variables }) => {
          if (scenario === "read-failure") {
            return { errors: [{ message: "Initiative lookup unavailable" }] }
          }
          const isName = "name" in (variables.filter as Record<string, unknown>)
          const matches = isName
            ? ["name", "ambiguous-name"].includes(scenario)
            : ["slug", "ambiguous-slug", "more-pages"].includes(scenario)
          return {
            data: {
              initiatives: {
                nodes: !matches
                  ? []
                  : scenario.startsWith("ambiguous")
                  ? [{ id }, { id: "other" }]
                  : [{ id }],
                pageInfo: {
                  hasNextPage: scenario === "more-pages",
                  endCursor: "next",
                },
              },
            },
          }
        },
      },
      {
        queryName: "ListInitiativeUpdates",
        response: {
          data: {
            initiative: {
              name: "Target",
              slugId: "target",
              initiativeUpdates: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    ])
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "initiative-update",
          "list",
          scenario === "UUID" ? id.toUpperCase() : "Target",
          "--json",
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const body = JSON.parse(new TextDecoder().decode(result.stdout))
      const success = ["slug", "name", "UUID"].includes(scenario)
      assertEquals(result.code, success ? 0 : 1, JSON.stringify(body))
      assertEquals(
        server.graphqlRequests.filter((request) =>
          request.query.includes("query ListInitiativeUpdates")
        ).map((request) => request.variables),
        success ? [{ id, first: 10 }] : [],
      )
      const lookups = server.graphqlRequests.filter((request) =>
        request.query.includes("query FindInitiative")
      )
      assertEquals(
        lookups.length,
        scenario === "UUID"
          ? 0
          : ["name", "ambiguous-name", "missing"].includes(scenario)
          ? 2
          : 1,
      )
      if (!success) {
        assertStringIncludes(
          body.error.message,
          scenario === "read-failure"
            ? "Initiative lookup unavailable"
            : scenario === "missing"
            ? "not found"
            : "ambiguous",
        )
      }
    } finally {
      await cleanup()
    }
  })
}

await cliffySnapshotTest({
  name: "Initiative Update List Command - JSON Output",
  meta: import.meta,
  colors: false,
  args: ["550e8400-e29b-41d4-a716-446655440000", "--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "ListInitiativeUpdates",
        variables: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          first: 10,
        },
        response: {
          data: {
            initiative: {
              name: "Alpha Initiative",
              slugId: "alpha",
              initiativeUpdates: {
                nodes: [
                  {
                    id: "update-1",
                    body: "Everything is on track.",
                    health: "onTrack",
                    url: "https://linear.app/test/update-1",
                    createdAt: "2026-02-15T10:00:00Z",
                    user: {
                      name: "alex.active",
                    },
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

await cliffySnapshotTest({
  name: "Initiative Update List Command - Rejects Invalid Limit",
  meta: import.meta,
  colors: false,
  args: ["550e8400-e29b-41d4-a716-446655440000", "--limit", "0"],
  denoArgs: commonDenoArgs,
  canFail: true,
  async fn() {
    await listCommand.parse()
  },
})
