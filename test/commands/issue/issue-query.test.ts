import { snapshotTest } from "@cliffy/testing"
import { assertEquals } from "@std/assert"
import { getColorEnabled, setColorEnabled } from "@std/fmt/colors"
import { fromFileUrl } from "@std/path"
import { stub } from "@std/testing/mock"
import { queryCommand } from "../../../src/commands/issue/issue-query.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))

// Test help output
await snapshotTest({
  name: "Issue Query Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs: commonDenoArgs,
  async fn() {
    queryCommand.help({ colors: false })
    await queryCommand.parse()
  },
})

// Mock issue data for reuse
const mockIssueNode = {
  id: "issue-1",
  identifier: "ENG-101",
  title: "Fix login bug",
  url: "https://linear.app/test/issue/ENG-101/fix-login-bug",
  priority: 2,
  priorityLabel: "High",
  estimate: 3,
  createdAt: "2026-04-01T10:00:00.000Z",
  updatedAt: "2026-04-02T08:15:00.000Z",
  state: {
    id: "state-1",
    name: "In Progress",
    color: "#f2c94c",
    type: "started",
  },
  assignee: {
    id: "user-1",
    name: "jane.smith",
    displayName: "Jane Smith",
    initials: "JS",
  },
  team: {
    id: "team-1",
    key: "ENG",
    name: "Engineering",
    cyclesEnabled: false,
    activeCycle: null,
  },
  project: {
    id: "project-1",
    name: "Auth Improvements",
  },
  projectMilestone: null,
  cycle: null,
  labels: {
    nodes: [
      { id: "label-1", name: "Bug", color: "#eb5757" },
    ],
  },
  inverseRelations: { nodes: [] },
}

// Test JSON output with filter mode (issues() backend)
await snapshotTest({
  name: "Issue Query Command - JSON Output",
  meta: import.meta,
  colors: false,
  args: [
    "--team",
    "ENG",
    "--state",
    "started",
    "--json",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      {
        queryName: "GetIssuesForQuery",
        variables: {
          filter: {
            team: { key: { eq: "ENG" } },
            state: { type: { in: ["started"] } },
          },
          sort: [
            { workflowState: { order: "Descending" } },
            { priority: { nulls: "last", order: "Descending" } },
            { manual: { nulls: "last", order: "Ascending" } },
          ],
          first: 50,
          includeProjectTeamMetadata: false,
          includeEstimationMetadata: false,
        },
        response: {
          data: {
            issues: {
              nodes: [mockIssueNode],
              pageInfo: { hasNextPage: false, endCursor: "cursor-1" },
            },
          },
        },
      },
    ], { NO_COLOR: "true" })

    try {
      await queryCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

Deno.test("Issue Query Command - filters by exact workflow state name", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      variables: {
        filter: {
          team: { key: { eq: "ENG" } },
          state: { name: { eqIgnoreCase: "Merged" } },
        },
        sort: [
          { workflowState: { order: "Descending" } },
          { priority: { nulls: "last", order: "Descending" } },
          { manual: { nulls: "last", order: "Ascending" } },
        ],
        first: 50,
      },
      response: {
        data: {
          issues: {
            nodes: [{
              ...mockIssueNode,
              state: { ...mockIssueNode.state, name: "Merged" },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ], { NO_COLOR: "true" })
  const logStub = stub(console, "log", () => {})

  try {
    await queryCommand.parse([
      "--team",
      "ENG",
      "--state-name",
      "Merged",
      "--json",
    ])
  } finally {
    logStub.restore()
    await cleanup()
  }
})

Deno.test("Issue Query Command - Project scope does not require a default team", async () => {
  const projectId = "00000000-0000-0000-0000-000000000001"
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      variables: {
        filter: { project: { id: { eq: projectId } } },
        sort: [
          { workflowState: { order: "Descending" } },
          { priority: { nulls: "last", order: "Descending" } },
          { manual: { nulls: "last", order: "Ascending" } },
        ],
        first: 50,
        includeProjectTeamMetadata: false,
        includeEstimationMetadata: false,
      },
      response: {
        data: {
          issues: {
            nodes: [mockIssueNode],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])
  const root = await Deno.makeTempDir()

  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--quiet",
        main,
        "issue",
        "query",
        "--project",
        projectId,
        "--json",
      ],
      cwd: root,
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        NO_COLOR: "1",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        LINEAR_API_KEY: "Bearer test-token",
      },
      stdout: "piped",
      stderr: "piped",
    }).output()

    const decoder = new TextDecoder()
    const stdout = decoder.decode(result.stdout)
    const stderr = decoder.decode(result.stderr)
    assertEquals(result.code, 0, stderr)
    assertEquals(stderr, "")
    assertEquals(
      JSON.parse(stdout).nodes.map((issue: { identifier: string }) =>
        issue.identifier
      ),
      ["ENG-101"],
    )
  } finally {
    await Deno.remove(root, { recursive: true })
    await cleanup()
  }
})

Deno.test("Issue Query Command - Explicit team narrows project scope", async () => {
  const projectId = "00000000-0000-0000-0000-000000000001"
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      variables: {
        filter: {
          team: { key: { eq: "ENG" } },
          project: { id: { eq: projectId } },
        },
        sort: [
          { workflowState: { order: "Descending" } },
          { priority: { nulls: "last", order: "Descending" } },
          { manual: { nulls: "last", order: "Ascending" } },
        ],
        first: 50,
        includeProjectTeamMetadata: false,
        includeEstimationMetadata: false,
      },
      response: {
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])

  try {
    await queryCommand.parse([
      "--project",
      projectId,
      "--team",
      "ENG",
      "--json",
    ])
  } finally {
    await cleanup()
  }
})

Deno.test("Issue Query Command - filters issues without a project", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      variables: { filter: { project: { null: true } } },
      response: {
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ], { NO_COLOR: "true" })

  try {
    await queryCommand.parse(["--all-teams", "--unprojected", "--json"])
  } finally {
    await cleanup()
  }
})

Deno.test("Issue Query Command - resolves self assignee without listing users", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetViewerId",
      response: { data: { viewer: { id: "user-self-123" } } },
    },
    {
      queryName: "GetIssuesForQuery",
      variables: {
        filter: { assignee: { id: { eq: "user-self-123" } } },
      },
      response: {
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ], { NO_COLOR: "true" })

  try {
    await queryCommand.parse(["--all-teams", "--assignee", "@me", "--json"])
  } finally {
    await cleanup()
  }
})

Deno.test("Issue Query Command - rejects conflicting project filters", async () => {
  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  try {
    await queryCommand.parse(["--project", "project-1", "--unprojected"])
  } catch {
    // expected
  } finally {
    errorStub.restore()
    exitStub.restore()
  }

  assertEquals(
    errorLogs.some((line) =>
      line.includes(
        "Cannot combine --project, --project-label, and --unprojected",
      )
    ),
    true,
  )
})

Deno.test("Issue Query Command - rejects unprojected milestone filters", async () => {
  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  try {
    await queryCommand.parse([
      "--all-teams",
      "--unprojected",
      "--milestone",
      "00000000-0000-0000-0000-000000000001",
    ])
  } catch {
    // expected
  } finally {
    errorStub.restore()
    exitStub.restore()
  }

  assertEquals(
    errorLogs.some((line) =>
      line.includes("--milestone cannot be used with --unprojected")
    ),
    true,
  )
})

Deno.test("Issue Query Command - Uses configured default team without project", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      variables: {
        filter: { team: { key: { eq: "ENG" } } },
        sort: [
          { workflowState: { order: "Descending" } },
          { priority: { nulls: "last", order: "Descending" } },
          { manual: { nulls: "last", order: "Ascending" } },
        ],
        first: 50,
        includeProjectTeamMetadata: false,
        includeEstimationMetadata: false,
      },
      response: {
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ], { LINEAR_TEAM_ID: "ENG", NO_COLOR: "true" })
  const errorStub = stub(console, "error", () => {})

  try {
    await queryCommand.parse(["--json"])
  } finally {
    errorStub.restore()
    await cleanup()
  }
})

// Test --search mode (searchIssues() backend) with JSON
await snapshotTest({
  name: "Issue Query Command - Search JSON Output",
  meta: import.meta,
  colors: false,
  args: [
    "--search",
    "oauth timeout",
    "--team",
    "ENG",
    "--state-name",
    "Merged",
    "--state-name",
    "In Review",
    "--search-comments",
    "--json",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      {
        queryName: "SearchIssues",
        variables: {
          term: "oauth timeout",
          filter: {
            team: { key: { eq: "ENG" } },
            state: {
              or: [
                { name: { eqIgnoreCase: "Merged" } },
                { name: { eqIgnoreCase: "In Review" } },
              ],
            },
          },
          includeComments: true,
        },
        response: {
          data: {
            searchIssues: {
              nodes: [{
                ...mockIssueNode,
                metadata: { context: {}, score: 0.42 },
              }],
              pageInfo: { hasNextPage: false, endCursor: "cursor-1" },
              totalCount: 1,
            },
          },
        },
      },
    ], { NO_COLOR: "true" })

    try {
      await queryCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

// Test --all-teams table output shows TEAM column
Deno.test("Issue Query Command - All Teams shows TEAM column", async () => {
  const fixedNow = new Date("2026-04-03T10:00:00.000Z")
  const RealDate = Date
  const originalColorEnabled = getColorEnabled()
  class MockDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value == null ? fixedNow.toISOString() : value)
    }
    static override now(): number {
      return fixedNow.getTime()
    }
  }
  globalThis.Date = MockDate as DateConstructor
  setColorEnabled(false)

  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      variables: {
        sort: [
          { workflowState: { order: "Descending" } },
          { priority: { nulls: "last", order: "Descending" } },
          { manual: { nulls: "last", order: "Ascending" } },
        ],
        first: 50,
      },
      response: {
        data: {
          issues: {
            nodes: [
              {
                ...mockIssueNode,
                team: { id: "team-1", key: "ENG", name: "Engineering" },
              },
              {
                ...mockIssueNode,
                id: "issue-2",
                identifier: "FE-42",
                title: "Fix CSS bug",
                team: { id: "team-2", key: "FE", name: "Frontend" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ], { NO_COLOR: "true" })

  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await queryCommand.parse(["--all-teams"])

    const output = logs.join("\n")
    // Header should contain TEAM column
    assertEquals(output.includes("TEAM"), true)
    // Should contain both team keys
    assertEquals(output.includes("ENG"), true)
    assertEquals(output.includes("FE"), true)
  } finally {
    logStub.restore()
    globalThis.Date = RealDate
    setColorEnabled(originalColorEnabled)
    await cleanup()
  }
})

// Blocked indicator in table output
Deno.test("Issue Query Command - Shows Blocked Indicator", async () => {
  const fixedNow = new Date("2026-04-03T10:00:00.000Z")
  const RealDate = Date
  const originalColorEnabled = getColorEnabled()
  class MockDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value == null ? fixedNow.toISOString() : value)
    }
    static override now(): number {
      return fixedNow.getTime()
    }
  }
  globalThis.Date = MockDate as DateConstructor
  setColorEnabled(false)

  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      response: {
        data: {
          issues: {
            nodes: [
              {
                ...mockIssueNode,
                id: "blocked-1",
                identifier: "ENG-300",
                title: "Blocked by open",
                inverseRelations: {
                  nodes: [{
                    id: "rel-a",
                    type: "blocks",
                    issue: {
                      id: "blocker",
                      identifier: "ENG-200",
                      state: { type: "started" },
                    },
                  }],
                },
              },
              {
                ...mockIssueNode,
                id: "unblocked-1",
                identifier: "ENG-301",
                title: "Blocker done",
                inverseRelations: {
                  nodes: [{
                    id: "rel-b",
                    type: "blocks",
                    issue: {
                      id: "blocker-done",
                      identifier: "ENG-201",
                      state: { type: "canceled" },
                    },
                  }],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ], { NO_COLOR: "true" })

  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await queryCommand.parse(["--team", "ENG"])

    const lines = logs.join("\n").split("\n")
    const blocked = lines.find((l) => l.includes("ENG-300"))!
    const unblocked = lines.find((l) => l.includes("ENG-301"))!
    assertEquals(blocked.includes("⊘"), true)
    assertEquals(unblocked.includes("⊘"), false)
  } finally {
    logStub.restore()
    globalThis.Date = RealDate
    setColorEnabled(originalColorEnabled)
    await cleanup()
  }
})

// Test validation: --team + --all-teams conflict
Deno.test("Issue Query Command - rejects --team with --all-teams", async () => {
  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  try {
    await queryCommand.parse(["--team", "ENG", "--all-teams"])
  } catch {
    // expected
  } finally {
    errorStub.restore()
    exitStub.restore()
  }

  assertEquals(
    errorLogs.some((l) => l.includes("Cannot use both --team and --all-teams")),
    true,
  )
})

for (
  const { name, args, expected } of [
    {
      name: "--state with --state-name",
      args: ["--team", "ENG", "--state", "started", "--state-name", "Merged"],
      expected: "Cannot use both --state and --state-name flags",
    },
    {
      name: "a blank --state-name",
      args: ["--team", "ENG", "--state-name", "   "],
      expected: "--state-name cannot be empty",
    },
  ]
) {
  Deno.test(`Issue Query Command - rejects ${name}`, async () => {
    const errorLogs: string[] = []
    const errorStub = stub(console, "error", (...values: unknown[]) => {
      errorLogs.push(values.map(String).join(" "))
    })
    const exitStub = stub(Deno, "exit", (_code?: number) => {
      throw new Error("EXIT")
    })

    try {
      await queryCommand.parse(args)
    } catch {
      // expected
    } finally {
      errorStub.restore()
      exitStub.restore()
    }

    assertEquals(errorLogs.some((line) => line.includes(expected)), true)
  })
}

// Test validation: --sort with --search conflict
Deno.test("Issue Query Command - rejects --sort with --search", async () => {
  const { cleanup } = await setupMockLinearServer([], {
    LINEAR_TEAM_ID: "ENG",
    NO_COLOR: "true",
  })

  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  try {
    await queryCommand.parse([
      "--search",
      "foo",
      "--sort",
      "priority",
      "--team",
      "ENG",
    ])
  } catch {
    // expected
  } finally {
    errorStub.restore()
    exitStub.restore()
    await cleanup()
  }

  assertEquals(
    errorLogs.some((l) => l.includes("--sort cannot be used with --search")),
    true,
  )
})

// Test validation: --search-comments without --search
Deno.test("Issue Query Command - rejects --search-comments without --search", async () => {
  const { cleanup } = await setupMockLinearServer([], {
    LINEAR_TEAM_ID: "ENG",
    NO_COLOR: "true",
  })

  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  try {
    await queryCommand.parse(["--search-comments", "--team", "ENG"])
  } catch {
    // expected
  } finally {
    errorStub.restore()
    exitStub.restore()
    await cleanup()
  }

  assertEquals(
    errorLogs.some((l) => l.includes("--search-comments requires --search")),
    true,
  )
})

// Test validation: --milestone without --project
Deno.test("Issue Query Command - rejects --milestone without --project", async () => {
  const { cleanup } = await setupMockLinearServer([], {
    LINEAR_TEAM_ID: "ENG",
    NO_COLOR: "true",
  })

  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  try {
    await queryCommand.parse(["--milestone", "v1", "--team", "ENG"])
  } catch {
    // expected
  } finally {
    errorStub.restore()
    exitStub.restore()
    await cleanup()
  }

  assertEquals(
    errorLogs.some((l) => l.includes("--milestone requires --project")),
    true,
  )
})

// Cycle column: shown when a team has cycles enabled, with relative tokens.
Deno.test("Issue Query Command - Shows Cycle Column", async () => {
  const fixedNow = new Date("2026-04-03T10:00:00.000Z")
  const RealDate = Date
  const originalColorEnabled = getColorEnabled()
  class MockDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value == null ? fixedNow.toISOString() : value)
    }
    static override now(): number {
      return fixedNow.getTime()
    }
  }
  globalThis.Date = MockDate as DateConstructor
  setColorEnabled(false)

  const cyclingTeam = {
    id: "team-1",
    key: "ENG",
    name: "Engineering",
    cyclesEnabled: true,
    activeCycle: { number: 3 },
  }

  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      response: {
        data: {
          issues: {
            nodes: [
              {
                ...mockIssueNode,
                team: cyclingTeam,
                cycle: {
                  id: "cycle-3",
                  number: 3,
                  name: null,
                  isActive: true,
                  isNext: false,
                  isPrevious: false,
                  isFuture: false,
                  isPast: false,
                },
              },
              {
                ...mockIssueNode,
                id: "issue-2",
                identifier: "ENG-102",
                title: "Plan ahead",
                team: cyclingTeam,
                cycle: {
                  id: "cycle-5",
                  number: 5,
                  name: null,
                  isActive: false,
                  isNext: false,
                  isPrevious: false,
                  isFuture: true,
                  isPast: false,
                },
              },
              {
                ...mockIssueNode,
                id: "issue-3",
                identifier: "ENG-103",
                title: "No cycle yet",
                team: cyclingTeam,
                cycle: null,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ], { NO_COLOR: "true" })

  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await queryCommand.parse(["--team", "ENG"])

    const [headerLine, ...rows] = logs
    assertEquals(headerLine.includes("CYC"), true)
    assertEquals(rows[0].includes(" now "), true)
    assertEquals(rows[1].includes(" +2 "), true)
    assertEquals(rows[2].includes(" -  "), true)
  } finally {
    logStub.restore()
    globalThis.Date = RealDate
    setColorEnabled(originalColorEnabled)
    await cleanup()
  }
})

// Cycle column omitted entirely when no listed team has cycles enabled.
Deno.test("Issue Query Command - Hides Cycle Column When Cycles Disabled", async () => {
  const fixedNow = new Date("2026-04-03T10:00:00.000Z")
  const RealDate = Date
  const originalColorEnabled = getColorEnabled()
  class MockDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value == null ? fixedNow.toISOString() : value)
    }
    static override now(): number {
      return fixedNow.getTime()
    }
  }
  globalThis.Date = MockDate as DateConstructor
  setColorEnabled(false)

  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      response: {
        data: {
          issues: {
            nodes: [mockIssueNode],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ], { NO_COLOR: "true" })

  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await queryCommand.parse(["--team", "ENG"])
    assertEquals(logs[0].includes("CYC"), false)
  } finally {
    logStub.restore()
    globalThis.Date = RealDate
    setColorEnabled(originalColorEnabled)
    await cleanup()
  }
})
