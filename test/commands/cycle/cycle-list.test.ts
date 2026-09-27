import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { setColorEnabled } from "@std/fmt/colors"
import { listCommand } from "../../../src/commands/cycle/cycle-list.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"
import { assertEquals, assertMatch } from "@std/assert"
import { stub } from "@std/testing/mock"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

await cliffySnapshotTest({
  name: "Cycle List Command - With Mock Cycles",
  meta: import.meta,
  colors: false,
  args: ["--team", "ENG"],
  denoArgs: commonDenoArgs,
  async fn() {
    setColorEnabled(false)
    const server = new MockLinearServer([
      {
        queryName: "GetWriteTeamByKey",
        response: {
          data: {
            teams: {
              nodes: [{ id: "team-eng-id", key: "ENG" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "GetTeamCycles",
        variables: { teamId: "team-eng-id" },
        response: {
          data: {
            team: {
              id: "team-eng-id",
              name: "Engineering",
              cycles: {
                nodes: [
                  {
                    id: "cycle-1",
                    number: 12,
                    name: "Sprint 12",
                    startsAt: "2026-02-10T00:00:00.000Z",
                    endsAt: "2026-02-24T00:00:00.000Z",
                    completedAt: "2026-02-24T00:00:00.000Z",
                    isActive: false,
                    isFuture: false,
                    isPast: true,
                  },
                  {
                    id: "cycle-2",
                    number: 13,
                    name: "Sprint 13",
                    startsAt: "2026-02-24T00:00:00.000Z",
                    endsAt: "2026-03-10T00:00:00.000Z",
                    completedAt: null,
                    isActive: true,
                    isFuture: false,
                    isPast: false,
                  },
                  {
                    id: "cycle-3",
                    number: 14,
                    name: "Sprint 14",
                    startsAt: "2026-03-10T00:00:00.000Z",
                    endsAt: "2026-03-24T00:00:00.000Z",
                    completedAt: null,
                    isActive: false,
                    isFuture: true,
                    isPast: false,
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
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
  name: "Cycle List Command - No Cycles Found",
  meta: import.meta,
  colors: false,
  args: ["--team", "ENG"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetWriteTeamByKey",
        response: {
          data: {
            teams: {
              nodes: [{ id: "team-eng-id", key: "ENG" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "GetTeamCycles",
        variables: { teamId: "team-eng-id" },
        response: {
          data: {
            team: {
              id: "team-eng-id",
              name: "Engineering",
              cycles: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
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

Deno.test("Cycle List Command - reads every page before sorting", async () => {
  const cycle = (number: number) => ({
    id: `cycle-${number}`,
    number,
    name: null,
    startsAt: new Date(Date.UTC(2024, 0, 1) + number * 14 * 86400000)
      .toISOString(),
    endsAt: new Date(Date.UTC(2024, 0, 15) + number * 14 * 86400000)
      .toISOString(),
    completedAt: null,
    isActive: false,
    isFuture: false,
    isPast: true,
  })
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetWriteTeamByKey",
      response: {
        data: {
          teams: {
            nodes: [{ id: "team-eng-id", key: "ENG" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      queryName: "GetTeamCycles",
      variables: { teamId: "team-eng-id", after: "cycles-100" },
      response: {
        data: {
          team: {
            id: "team-eng-id",
            name: "Engineering",
            cycles: {
              nodes: [cycle(101)],
              pageInfo: { hasNextPage: false, endCursor: "cycles-101" },
            },
          },
        },
      },
    },
    {
      queryName: "GetTeamCycles",
      variables: { teamId: "team-eng-id" },
      response: {
        data: {
          team: {
            id: "team-eng-id",
            name: "Engineering",
            cycles: {
              nodes: Array.from({ length: 100 }, (_, i) => cycle(i + 1)),
              pageInfo: { hasNextPage: true, endCursor: "cycles-100" },
            },
          },
        },
      },
    },
  ], { NO_COLOR: "1" })
  const stdout: string[] = []
  const log = stub(console, "log", (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "))
  })
  try {
    await listCommand.parse(["--team", "ENG"])
  } finally {
    log.restore()
    await cleanup()
  }
  // Header plus 101 cycles, newest (from the second page) first.
  assertEquals(stdout.length, 102)
  assertMatch(stdout[1], /^101 +Cycle 101 /)
  assertEquals(
    server.graphqlRequests
      .filter((request) => request.query.includes("query GetTeamCycles"))
      .map((request) => request.variables.after ?? null),
    [null, "cycles-100"],
  )
})
