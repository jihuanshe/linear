import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { listCommand } from "../../../src/commands/initiative/initiative-list.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

for (
  const status of [
    "Planned",
    "Active",
    "Completed",
    "Proposed",
    "Canceled",
    "",
    "unknown",
  ]
) {
  Deno.test(`initiative list explicit status ${JSON.stringify(status)}`, async () => {
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "GetInitiatives",
        response: {
          data: {
            initiatives: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
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
          "initiative",
          "list",
          "--status",
          status.toUpperCase(),
          "--json",
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const valid = status !== "" && status !== "unknown"
      assertEquals(
        result.code,
        valid ? 0 : 1,
        new TextDecoder().decode(result.stdout),
      )
      assertEquals(
        server.graphqlRequests.map((request) => request.variables),
        valid
          ? [{ filter: { status: { eq: status } }, includeArchived: false }]
          : [],
      )
      if (!valid) {
        const body = JSON.parse(new TextDecoder().decode(result.stdout))
        assertStringIncludes(body.error.message, "Invalid status")
      }
    } finally {
      await cleanup()
    }
  })
}

Deno.test("initiative list still displays unknown remote statuses", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetInitiatives",
      response: {
        data: {
          initiatives: {
            nodes: [{
              id: "future",
              slugId: "future",
              name: "Future initiative",
              status: "FutureState",
              projects: { nodes: [] },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])
  const logs: string[] = []
  const log = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.join(" "))
  })
  try {
    await listCommand.parse(["--all-statuses"])
    assertStringIncludes(logs.join("\n"), "FutureState")
  } finally {
    log.restore()
    await cleanup()
  }
})

await cliffySnapshotTest({
  name: "Initiative List Command - JSON Output",
  meta: import.meta,
  colors: false,
  args: ["--all-statuses", "--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetInitiatives",
        variables: { filter: undefined, includeArchived: false },
        response: {
          data: {
            initiatives: {
              nodes: [
                {
                  id: "initiative-2",
                  slugId: "plan-b",
                  name: "Plan B",
                  description: "Second initiative",
                  status: "Planned",
                  targetDate: "2026-06-01",
                  health: "atRisk",
                  color: "#f59e0b",
                  icon: "🟡",
                  url: "https://linear.app/test/initiative/plan-b",
                  archivedAt: null,
                  owner: {
                    id: "owner-2",
                    displayName: "Pat Planner",
                    initials: "PP",
                  },
                  projects: {
                    nodes: [
                      {
                        id: "project-2",
                        name: "Project B",
                        status: { name: "Planned" },
                      },
                    ],
                  },
                },
                {
                  id: "initiative-1",
                  slugId: "alpha",
                  name: "Alpha",
                  description: "First initiative",
                  status: "Active",
                  targetDate: "2026-05-01",
                  health: "onTrack",
                  color: "#10b981",
                  icon: "🟢",
                  url: "https://linear.app/test/initiative/alpha",
                  archivedAt: null,
                  owner: {
                    id: "owner-1",
                    displayName: "Alex Active",
                    initials: "AA",
                  },
                  projects: {
                    nodes: [
                      {
                        id: "project-1",
                        name: "Project A",
                        status: { name: "In Progress" },
                      },
                    ],
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
