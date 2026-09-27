import { snapshotTest } from "@cliffy/testing"
import { viewCommand } from "../../../src/commands/cycle/cycle-view.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"

await snapshotTest({
  name: "Cycle View Command - Active Cycle With Issues",
  meta: import.meta,
  colors: false,
  args: ["active", "--team", "ENG"],
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
        queryName: "GetTeamCyclesForLookup",
        response: {
          data: {
            team: {
              key: "ENG",
              cyclesEnabled: true,
              cycles: {
                nodes: [
                  {
                    id: "cycle-1",
                    number: 12,
                    startsAt: "2026-07-27T07:00:00.000Z",
                    name: "Sprint 12",
                  },
                  {
                    id: "cycle-2",
                    number: 13,
                    startsAt: "2026-07-27T07:00:00.000Z",
                    name: "Sprint 13",
                  },
                ],
              },
              activeCycle: {
                id: "cycle-2",
                number: 13,
                startsAt: "2026-07-27T07:00:00.000Z",
                name: "Sprint 13",
              },
            },
          },
        },
      },
      {
        queryName: "GetCycleDetails",
        variables: { id: "cycle-2" },
        response: {
          data: {
            cycle: {
              id: "cycle-2",
              number: 13,
              name: "Sprint 13",
              description: "Focus on performance improvements",
              startsAt: "2026-02-24T00:00:00.000Z",
              endsAt: "2026-03-10T00:00:00.000Z",
              completedAt: null,
              isActive: true,
              isFuture: false,
              isPast: false,
              createdAt: "2020-01-01T10:00:00Z",
              updatedAt: "2020-01-15T14:30:00Z",
              team: {
                id: "team-eng-id",
                key: "ENG",
                name: "Engineering",
              },
              issues: {
                nodes: [
                  {
                    id: "issue-1",
                    identifier: "ENG-412",
                    title: "Fix auth token refresh",
                    state: { name: "In Progress", type: "started" },
                  },
                  {
                    id: "issue-2",
                    identifier: "ENG-398",
                    title: "Add dark mode toggle",
                    state: { name: "Todo", type: "unstarted" },
                  },
                  {
                    id: "issue-3",
                    identifier: "ENG-401",
                    title: "Update onboarding flow",
                    state: { name: "Done", type: "completed" },
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

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await snapshotTest({
  name: "Cycle View Command - Cycle With No Issues",
  meta: import.meta,
  colors: false,
  args: ["14", "--team", "ENG"],
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
        queryName: "GetTeamCyclesForLookup",
        response: {
          data: {
            team: {
              key: "ENG",
              cyclesEnabled: true,
              cycles: {
                nodes: [
                  {
                    id: "cycle-3",
                    number: 14,
                    startsAt: "2026-07-27T07:00:00.000Z",
                    name: "Sprint 14",
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              activeCycle: null,
            },
          },
        },
      },
      {
        queryName: "GetCycleDetails",
        variables: { id: "cycle-3" },
        response: {
          data: {
            cycle: {
              id: "cycle-3",
              number: 14,
              name: "Sprint 14",
              description: null,
              startsAt: "2026-03-10T00:00:00.000Z",
              endsAt: "2026-03-24T00:00:00.000Z",
              completedAt: null,
              isActive: false,
              isFuture: true,
              isPast: false,
              createdAt: "2020-01-01T10:00:00Z",
              updatedAt: "2020-01-01T10:00:00Z",
              team: {
                id: "team-eng-id",
                key: "ENG",
                name: "Engineering",
              },
              issues: {
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

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await snapshotTest({
  name: "Cycle View Command - Many Issues Truncated",
  meta: import.meta,
  colors: false,
  args: ["12", "--team", "ENG"],
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
        queryName: "GetTeamCyclesForLookup",
        response: {
          data: {
            team: {
              key: "ENG",
              cyclesEnabled: true,
              cycles: {
                nodes: [
                  {
                    id: "cycle-1",
                    number: 12,
                    startsAt: "2026-07-27T07:00:00.000Z",
                    name: "Sprint 12",
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              activeCycle: null,
            },
          },
        },
      },
      {
        queryName: "GetCycleDetails",
        variables: { id: "cycle-1" },
        response: {
          data: {
            cycle: {
              id: "cycle-1",
              number: 12,
              name: "Sprint 12",
              description: "Completed sprint",
              startsAt: "2026-02-10T00:00:00.000Z",
              endsAt: "2026-02-24T00:00:00.000Z",
              completedAt: "2026-02-24T00:00:00.000Z",
              isActive: false,
              isFuture: false,
              isPast: true,
              createdAt: "2020-01-01T10:00:00Z",
              updatedAt: "2020-01-20T16:45:00Z",
              team: {
                id: "team-eng-id",
                key: "ENG",
                name: "Engineering",
              },
              issues: {
                nodes: Array.from({ length: 15 }, (_, i) => ({
                  id: `issue-${i + 1}`,
                  identifier: `ENG-${100 + i}`,
                  title: `Task ${i + 1}`,
                  state: {
                    name: i < 8 ? "Done" : i < 12 ? "In Progress" : "Todo",
                    type: i < 8
                      ? "completed"
                      : i < 12
                      ? "started"
                      : "unstarted",
                  },
                })),
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

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

Deno.test("Cycle View Command - progress counts every page of issues", async () => {
  const issue = (i: number) => ({
    id: `issue-${i}`,
    identifier: `ENG-${i}`,
    title: `Task ${i}`,
    // 90 of 150 are completed; only 40 of them are on the first page.
    state: i < 40 || i >= 100
      ? { name: "Done", type: "completed" }
      : { name: "Todo", type: "unstarted" },
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
      queryName: "GetTeamCyclesForLookup",
      response: {
        data: {
          team: {
            key: "ENG",
            cyclesEnabled: true,
            cycles: {
              nodes: [{
                id: "cycle-1",
                number: 12,
                startsAt: "2026-07-27T07:00:00.000Z",
                name: "Sprint 12",
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            activeCycle: null,
          },
        },
      },
    },
    {
      queryName: "GetCycleDetails",
      variables: { id: "cycle-1" },
      response: {
        data: {
          cycle: {
            id: "cycle-1",
            number: 12,
            name: "Sprint 12",
            description: null,
            startsAt: "2026-02-10T00:00:00.000Z",
            endsAt: "2026-02-24T00:00:00.000Z",
            completedAt: null,
            isActive: true,
            isFuture: false,
            isPast: false,
            createdAt: "2020-01-01T10:00:00Z",
            updatedAt: "2020-01-20T16:45:00Z",
            team: { id: "team-eng-id", key: "ENG", name: "Engineering" },
            issues: {
              nodes: Array.from({ length: 100 }, (_, i) => issue(i)),
              pageInfo: { hasNextPage: true, endCursor: "issues-100" },
            },
          },
        },
      },
    },
    {
      queryName: "GetCycleIssues",
      variables: { id: "cycle-1", first: 100, after: "issues-100" },
      response: {
        data: {
          cycle: {
            id: "cycle-1",
            issues: {
              nodes: Array.from({ length: 50 }, (_, i) => issue(100 + i)),
              pageInfo: { hasNextPage: false, endCursor: "issues-150" },
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
    await viewCommand.parse(["12", "--team", "ENG"])
  } finally {
    log.restore()
    await cleanup()
  }
  const output = stdout.join("\n")
  assertStringIncludes(output, "**Progress:** 90/150 (60%)")
  assertStringIncludes(output, "**Total Issues:** 150")
  assertStringIncludes(output, "**To Do:** 60")
  assertStringIncludes(output, "_...and 140 more issues_")
  assertEquals(
    server.graphqlRequests
      .filter((request) => request.query.includes("query GetCycleIssues"))
      .length,
    1,
  )
})
