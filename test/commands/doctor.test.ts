import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { doctorCommand } from "../../src/commands/doctor.ts"
import { setupMockLinearServer } from "../utils/test-helpers.ts"

const baseIssue = {
  id: "issue-1",
  identifier: "JHS-101",
  title: "治理测试 Issue",
  url: "https://linear.app/test/issue/JHS-101/governance-test",
  priority: 2,
  priorityLabel: "High",
  estimate: 2,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  state: {
    id: "state-1",
    name: "In Progress",
    color: "#f2c94c",
    type: "started",
  },
  assignee: {
    id: "user-1",
    name: "alex",
    displayName: "Alex",
    initials: "AL",
  },
  team: {
    id: "team-1",
    key: "JHS",
    name: "集换社",
    cyclesEnabled: true,
    activeCycle: { number: 16 },
  },
  project: {
    id: "project-1",
    name: "治理项目",
    teams: { nodes: [{ key: "JHS" }] },
  },
  projectMilestone: null,
  cycle: {
    id: "cycle-1",
    number: 16,
    name: "Cycle 16",
    isActive: true,
    isNext: false,
    isPrevious: false,
    isFuture: false,
    isPast: false,
  },
  labels: { nodes: [] },
  inverseRelations: { nodes: [] },
}

type TestIssue = Omit<typeof baseIssue, "project"> & {
  project: typeof baseIssue.project | null
}

function issueResponse(issue: TestIssue = baseIssue) {
  return {
    data: {
      issues: {
        nodes: [issue],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  }
}

function issueQueryVariables() {
  return {
    sort: [
      { workflowState: { order: "Descending" } },
      { priority: { nulls: "last", order: "Descending" } },
      { manual: { nulls: "last", order: "Ascending" } },
    ],
    filter: { assignee: { id: { eq: "user-1" } } },
    first: 100,
  }
}

Deno.test("Doctor command outputs a complete JSON report", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetViewerId",
      response: { data: { viewer: { id: "user-1" } } },
    },
    {
      queryName: "GetIssuesForQuery",
      variables: issueQueryVariables(),
      response: issueResponse(),
    },
    {
      queryName: "GetProjectsForDoctor",
      response: {
        data: {
          projects: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])
  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await doctorCommand.parse(["self", "--json"])
  } finally {
    logStub.restore()
    await cleanup()
  }

  const report = JSON.parse(logs.join(""))
  assertEquals(report.schemaVersion, 1)
  assertEquals(report.scope, { kind: "self", target: "self" })
  assertEquals(report.scanned.issueCount, 1)
  assertEquals(report.summary.findingCount, 0)
  assertEquals(report.strategySummaries.length, 4)
  assertEquals(
    report.strategySummaries.map((strategy: { id: string }) => strategy.id),
    [
      "execution-readiness",
      "project-pulse",
      "ownership-and-classification",
      "flow-progress",
    ],
  )
  assertEquals(report.findings, [])
})

Deno.test("Doctor command shows title and human recommendation", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetViewerId",
      response: { data: { viewer: { id: "user-1" } } },
    },
    {
      queryName: "GetIssuesForQuery",
      variables: issueQueryVariables(),
      response: issueResponse({
        ...baseIssue,
        project: null,
      }),
    },
    {
      queryName: "GetProjectsForDoctor",
      response: {
        data: {
          projects: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])
  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await doctorCommand.parse(["self", "--rule", "missing-project"])
  } finally {
    logStub.restore()
    await cleanup()
  }

  const output = logs.join("\n")
  assertEquals(output.includes("JHS-101"), true)
  assertEquals(output.includes("治理测试 Issue"), true)
  assertEquals(output.includes("项目=-"), true)
  assertEquals(output.includes("请为该任务指定项目"), true)
})

Deno.test("Doctor command reports stale Project Updates", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      variables: issueQueryVariables(),
      response: issueResponse(),
    },
    {
      queryName: "GetViewerId",
      response: { data: { viewer: { id: "user-1" } } },
    },
    {
      queryName: "GetProjectsForDoctor",
      response: {
        data: {
          projects: {
            nodes: [{
              id: "project-1",
              name: "治理项目",
              createdAt: "2026-01-01T00:00:00.000Z",
              startedAt: "2026-01-01T00:00:00.000Z",
              status: { name: "Started", type: "started" },
              health: "onTrack",
              healthUpdatedAt: "2026-01-01T00:00:00.000Z",
              lastUpdate: {
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                health: "onTrack",
                isStale: false,
              },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])
  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await doctorCommand.parse([
      "self",
      "--rule",
      "stale-project-update",
      "--stale-days",
      "1",
    ])
  } finally {
    logStub.restore()
    await cleanup()
  }

  const output = logs.join("\n")
  assertEquals(output.includes("项目"), true)
  assertEquals(output.includes("治理项目"), true)
  assertEquals(output.includes("项目更新过期"), true)
  assertEquals(output.includes("项目更新=2026-01-01"), true)
})
