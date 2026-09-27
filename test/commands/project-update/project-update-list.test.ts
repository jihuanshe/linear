import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { listCommand } from "../../../src/commands/project-update/project-update-list.ts"
import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

await cliffySnapshotTest({
  name: "Project Update List Command - JSON Output",
  meta: import.meta,
  colors: false,
  args: ["550e8400-e29b-41d4-a716-446655440000", "--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "ListProjectUpdates",
        variables: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          first: 10,
        },
        response: {
          data: {
            project: {
              name: "JSON Project",
              slugId: "json-project",
              projectUpdates: {
                nodes: [
                  {
                    id: "project-update-1",
                    body: "Project is healthy.",
                    health: "onTrack",
                    url: "https://linear.app/test/project-update-1",
                    createdAt: "2026-02-10T09:00:00Z",
                    user: {
                      name: "alex.active",
                      displayName: "Alex Active",
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
  name: "Project Update List Command - Rejects Invalid Limit",
  meta: import.meta,
  colors: false,
  args: ["550e8400-e29b-41d4-a716-446655440000", "--limit", "-1"],
  denoArgs: commonDenoArgs,
  canFail: true,
  async fn() {
    await listCommand.parse()
  },
})

for (const mode of ["default", "default-json", "all"] as const) {
  Deno.test(`Project Update List Command - pagination and truncation hint (${mode})`, async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000"
    const update = (i: number) => ({
      id: `update-${i}-0000-0000`,
      body: `Update ${i}`,
      health: "onTrack",
      url: `https://linear.app/test/project/update-${i}`,
      createdAt: "2026-01-18T10:30:00Z",
      user: null,
    })
    const project = (
      nodes: ReturnType<typeof update>[],
      pageInfo: { hasNextPage: boolean; endCursor: string },
    ) => ({
      data: {
        project: {
          name: "Big",
          slugId: "big",
          projectUpdates: { nodes, pageInfo },
        },
      },
    })
    const firstPage = Array.from({ length: 10 }, (_, i) => update(i))
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "ListProjectUpdates",
        variables: { after: "updates-10" },
        response: project([update(10)], {
          hasNextPage: false,
          endCursor: "updates-11",
        }),
      },
      {
        queryName: "ListProjectUpdates",
        response: project(firstPage, {
          hasNextPage: true,
          endCursor: "updates-10",
        }),
      },
    ], { NO_COLOR: "1" })
    const stdout: string[] = []
    const stderr: string[] = []
    const log = stub(console, "log", (...args: unknown[]) => {
      stdout.push(args.map(String).join(" "))
    })
    const error = stub(console, "error", (...args: unknown[]) => {
      stderr.push(args.map(String).join(" "))
    })
    try {
      await listCommand.parse([
        id,
        ...(mode === "all" ? ["--limit", "0"] : []),
        ...(mode === "default-json" ? ["--json"] : []),
      ])
    } finally {
      error.restore()
      log.restore()
      await cleanup()
    }
    assertEquals(
      server.graphqlRequests.map(({ variables }) => [
        variables.first,
        variables.after ?? null,
      ]),
      mode === "all" ? [[100, null], [100, "updates-10"]] : [[10, null]],
    )
    if (mode === "default-json") {
      assertEquals(
        JSON.parse(stdout.join("\n")).projectUpdates.pageInfo.hasNextPage,
        true,
      )
      assertEquals(stderr, [])
    } else {
      assertEquals(
        stdout.filter((line) => line.startsWith("update-")).length,
        mode === "all" ? 11 : 10,
      )
      assertEquals(
        stderr,
        mode === "all" ? [] : [
          "Showing the first 10 updates; more exist. Use --limit 0 to fetch all pages.",
        ],
      )
    }
  })
}
