import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals } from "@std/assert"
import { stubDate } from "../../utils/stub-date.ts"
import { listCommand } from "../../../src/commands/project/project-list.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"
import { fromFileUrl } from "@std/path"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

// Test with mock server - Projects list
await cliffySnapshotTest({
  name: "Project List Command - With Mock Projects",
  meta: import.meta,
  colors: false,
  args: ["--all-teams"],
  denoArgs: commonDenoArgs,
  async fn() {
    using _date = stubDate("2025-08-17T15:30:00Z")
    const server = new MockLinearServer([
      {
        queryName: "GetProjects",
        variables: { filter: undefined, first: 100, after: undefined },
        response: {
          data: {
            projects: {
              nodes: [
                {
                  id: "project-1",
                  name: "Authentication System",
                  description: "Core authentication and authorization system",
                  slugId: "auth-sys",
                  icon: "🔐",
                  color: "#3b82f6",
                  status: {
                    id: "status-1",
                    name: "In Progress",
                    color: "#f59e0b",
                    type: "started",
                  },
                  lead: {
                    name: "jane.smith",
                    displayName: "Jane Smith",
                    initials: "JS",
                  },
                  priority: 2,
                  health: "onTrack",
                  startDate: "2024-01-15",
                  targetDate: "2024-03-30",
                  startedAt: "2024-01-16T09:00:00Z",
                  completedAt: null,
                  canceledAt: null,
                  createdAt: "2024-01-10T10:00:00Z",
                  updatedAt: "2024-01-20T15:30:00Z",
                  url: "https://linear.app/test/project/auth-sys",
                  teams: {
                    nodes: [
                      { key: "BACKEND" },
                      { key: "SECURITY" },
                    ],
                  },
                },
                {
                  id: "project-2",
                  name: "Mobile App UI Redesign",
                  description:
                    "Complete redesign of the mobile application interface",
                  slugId: "mobile-ui",
                  icon: "📱",
                  color: "#ef4444",
                  status: {
                    id: "status-2",
                    name: "Planned",
                    color: "#6366f1",
                    type: "planned",
                  },
                  lead: {
                    name: "alex.designer",
                    displayName: "Alex Designer",
                    initials: "AD",
                  },
                  priority: 3,
                  health: null,
                  startDate: "2024-04-01",
                  targetDate: "2024-06-15",
                  startedAt: null,
                  completedAt: null,
                  canceledAt: null,
                  createdAt: "2024-01-05T14:00:00Z",
                  updatedAt: "2024-01-18T11:15:00Z",
                  url: "https://linear.app/test/project/mobile-ui",
                  teams: {
                    nodes: [
                      { key: "DESIGN" },
                      { key: "MOBILE" },
                    ],
                  },
                },
                {
                  id: "project-3",
                  name: "API Documentation",
                  description: "Comprehensive API documentation and examples",
                  slugId: "api-docs",
                  icon: null,
                  color: "#10b981",
                  status: {
                    id: "status-3",
                    name: "Completed",
                    color: "#059669",
                    type: "completed",
                  },
                  lead: null,
                  priority: 4,
                  health: "onTrack",
                  startDate: "2023-11-01",
                  targetDate: "2024-01-01",
                  startedAt: "2023-11-05T08:00:00Z",
                  completedAt: "2023-12-20T17:30:00Z",
                  canceledAt: null,
                  createdAt: "2023-10-25T09:00:00Z",
                  updatedAt: "2023-12-20T17:30:00Z",
                  url: "https://linear.app/test/project/api-docs",
                  teams: {
                    nodes: [
                      { key: "DOCS" },
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

// Test with empty projects list
await cliffySnapshotTest({
  name: "Project List Command - No Projects Found",
  meta: import.meta,
  colors: false,
  args: ["--all-teams"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjects",
        variables: { filter: undefined, first: 100, after: undefined },
        response: {
          data: {
            projects: {
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

// Test with empty projects list and --json
await cliffySnapshotTest({
  name: "Project List Command - No Projects Found JSON",
  meta: import.meta,
  colors: false,
  args: ["--all-teams", "--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjects",
        variables: { filter: undefined, first: 100, after: undefined },
        response: {
          data: {
            projects: {
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

// Test with projects and --json
await cliffySnapshotTest({
  name: "Project List Command - With JSON Output",
  meta: import.meta,
  colors: false,
  args: ["--all-teams", "--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjects",
        variables: { filter: undefined, first: 100, after: undefined },
        response: {
          data: {
            projects: {
              nodes: [
                {
                  id: "project-json-1",
                  name: "JSON Test Project",
                  description: "A project for JSON output",
                  slugId: "json-proj",
                  icon: null,
                  color: "#3b82f6",
                  status: {
                    id: "status-1",
                    name: "In Progress",
                    color: "#f59e0b",
                    type: "started",
                  },
                  lead: {
                    name: "test.user",
                    displayName: "Test User",
                    initials: "TU",
                  },
                  priority: 2,
                  health: "onTrack",
                  startDate: "2024-01-15",
                  targetDate: "2024-03-30",
                  startedAt: "2024-01-16T09:00:00Z",
                  completedAt: null,
                  canceledAt: null,
                  createdAt: "2024-01-10T10:00:00Z",
                  updatedAt: "2024-01-20T15:30:00Z",
                  url: "https://linear.app/test/project/json-proj",
                  teams: {
                    nodes: [{ key: "ENG" }],
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

// Test pagination - multiple pages
await cliffySnapshotTest({
  name: "Project List Command - Pagination (Multiple Pages)",
  meta: import.meta,
  colors: false,
  args: ["--all-teams"],
  denoArgs: commonDenoArgs,
  async fn() {
    using _date = stubDate("2025-08-17T15:30:00Z")
    const server = new MockLinearServer([
      // First page
      {
        queryName: "GetProjects",
        variables: { filter: undefined, first: 100, after: undefined },
        response: {
          data: {
            projects: {
              nodes: [
                {
                  id: "project-page1-1",
                  name: "Alpha Project",
                  description: "First project on page 1",
                  slugId: "alpha-proj",
                  icon: "🅰️",
                  color: "#3b82f6",
                  status: {
                    id: "status-1",
                    name: "In Progress",
                    color: "#f59e0b",
                    type: "started",
                  },
                  lead: {
                    name: "alice",
                    displayName: "Alice Smith",
                    initials: "AS",
                  },
                  priority: 2,
                  health: "onTrack",
                  startDate: "2024-01-15",
                  targetDate: "2024-03-30",
                  startedAt: "2024-01-16T09:00:00Z",
                  completedAt: null,
                  canceledAt: null,
                  createdAt: "2024-01-10T10:00:00Z",
                  updatedAt: "2024-06-15T12:00:00Z",
                  url: "https://linear.app/test/project/alpha-proj",
                  teams: {
                    nodes: [{ key: "TEAM1" }],
                  },
                },
                {
                  id: "project-page1-2",
                  name: "Beta Project",
                  description: "Second project on page 1",
                  slugId: "beta-proj",
                  icon: "🅱️",
                  color: "#ef4444",
                  status: {
                    id: "status-2",
                    name: "Planned",
                    color: "#6366f1",
                    type: "planned",
                  },
                  lead: {
                    name: "bob",
                    displayName: "Bob Jones",
                    initials: "BJ",
                  },
                  priority: 3,
                  health: null,
                  startDate: "2024-04-01",
                  targetDate: "2024-06-15",
                  startedAt: null,
                  completedAt: null,
                  canceledAt: null,
                  createdAt: "2024-01-05T14:00:00Z",
                  updatedAt: "2024-06-16T12:00:00Z",
                  url: "https://linear.app/test/project/beta-proj",
                  teams: {
                    nodes: [{ key: "TEAM2" }],
                  },
                },
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-page-1-end",
              },
            },
          },
        },
      },
      // Second page
      {
        queryName: "GetProjects",
        variables: {
          filter: undefined,
          first: 100,
          after: "cursor-page-1-end",
        },
        response: {
          data: {
            projects: {
              nodes: [
                {
                  id: "project-page2-1",
                  name: "Gamma Project",
                  description: "First project on page 2",
                  slugId: "gamma-proj",
                  icon: "🔤",
                  color: "#10b981",
                  status: {
                    id: "status-3",
                    name: "In Progress",
                    color: "#f59e0b",
                    type: "started",
                  },
                  lead: {
                    name: "carol",
                    displayName: "Carol White",
                    initials: "CW",
                  },
                  priority: 1,
                  health: "atRisk",
                  startDate: "2024-02-01",
                  targetDate: "2024-04-30",
                  startedAt: "2024-02-05T09:00:00Z",
                  completedAt: null,
                  canceledAt: null,
                  createdAt: "2024-01-20T10:00:00Z",
                  updatedAt: "2024-06-17T12:00:00Z",
                  url: "https://linear.app/test/project/gamma-proj",
                  teams: {
                    nodes: [{ key: "TEAM3" }],
                  },
                },
                {
                  id: "project-page2-2",
                  name: "Delta Project",
                  description: "Second project on page 2",
                  slugId: "delta-proj",
                  icon: "🔺",
                  color: "#f59e0b",
                  status: {
                    id: "status-4",
                    name: "Completed",
                    color: "#059669",
                    type: "completed",
                  },
                  lead: null,
                  priority: 4,
                  health: "onTrack",
                  startDate: "2023-11-01",
                  targetDate: "2024-01-01",
                  startedAt: "2023-11-05T08:00:00Z",
                  completedAt: "2023-12-20T17:30:00Z",
                  canceledAt: null,
                  createdAt: "2023-10-25T09:00:00Z",
                  updatedAt: "2024-06-18T12:00:00Z",
                  url: "https://linear.app/test/project/delta-proj",
                  teams: {
                    nodes: [{ key: "TEAM4" }],
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
      assertEquals(
        server.graphqlRequests.map((q) => q.variables.after ?? null),
        [null, "cursor-page-1-end"],
      )
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "Project List Command - JSON Output With Pagination",
  meta: import.meta,
  colors: false,
  args: ["--all-teams", "--json", "--limit", "1"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjects",
        variables: { filter: undefined, first: 1, after: undefined },
        response: {
          data: {
            projects: {
              nodes: [
                {
                  id: "project-page1-1",
                  name: "Alpha Project",
                  description: "First page project",
                  slugId: "alpha-proj",
                  icon: null,
                  color: "#3b82f6",
                  status: {
                    id: "status-1",
                    name: "In Progress",
                    color: "#f59e0b",
                    type: "started",
                  },
                  lead: null,
                  priority: 2,
                  health: "onTrack",
                  startDate: null,
                  targetDate: null,
                  startedAt: null,
                  completedAt: null,
                  canceledAt: null,
                  createdAt: "2024-01-10T10:00:00Z",
                  updatedAt: "2024-01-20T15:30:00Z",
                  url: "https://linear.app/test/project/alpha-proj",
                  teams: {
                    nodes: [{ key: "ENG" }],
                  },
                },
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
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

async function runMain(server: MockLinearServer, args: string[]) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      "--quiet",
      fromFileUrl(new URL("../../../src/main.ts", import.meta.url)),
      ...args,
    ],
    env: {
      NO_COLOR: "1",
      LINEAR_PROMPT_DISABLED: "1",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_API_KEY: "Bearer test-token",
    },
    stdout: "piped",
    stderr: "piped",
  }).output()
  const decoder = new TextDecoder()
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  }
}

Deno.test("project list --limit selects the same projects for human and JSON output", async () => {
  const project = (slugId: string, name: string, type: string) => ({
    id: `project-${slugId}`,
    name,
    description: "",
    slugId,
    icon: null,
    color: "#3b82f6",
    status: { id: `status-${type}`, name: type, color: "#f59e0b", type },
    lead: null,
    priority: 0,
    health: null,
    startDate: null,
    targetDate: null,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    createdAt: "2024-01-10T10:00:00Z",
    updatedAt: "2024-01-20T15:30:00Z",
    url: `https://linear.app/test/project/${slugId}`,
    teams: { nodes: [{ key: "ENG" }] },
  })
  const pageInfo = { hasNextPage: true, endCursor: "cursor-1" }
  // Only the bounded first page is mocked: reading every page and slicing
  // after the sort would request first: 100 and fail against this server.
  const server = new MockLinearServer([{
    queryName: "GetProjects",
    variables: { filter: undefined, first: 2, after: undefined },
    response: {
      data: {
        projects: {
          nodes: [
            project("plan-b", "Beta", "planned"),
            project("start-a", "Alpha", "started"),
          ],
          pageInfo,
        },
      },
    },
  }])
  await server.start()
  try {
    const args = ["project", "list", "--all-teams", "--limit", "2"]
    const json = await runMain(server, [...args, "--json"])
    assertEquals(json.code, 0, json.stdout + json.stderr)
    assertEquals(json.stderr, "")
    const parsed = JSON.parse(json.stdout)
    assertEquals(
      parsed.nodes.map((node: { slugId: string }) => node.slugId),
      ["start-a", "plan-b"],
    )
    assertEquals(parsed.pageInfo, pageInfo)

    const human = await runMain(server, args)
    assertEquals(human.code, 0, human.stdout + human.stderr)
    assertEquals(
      human.stdout.trimEnd().split("\n").slice(1).map((line) =>
        line.split(" ")[0]
      ),
      ["start-a", "plan-b"],
    )
    assertEquals(
      human.stderr,
      "Showing the first 2 projects; more exist. Use --limit 0 to fetch all pages.\n",
    )
    assertEquals(
      server.graphqlRequests.map(({ variables }) => variables.first),
      [2, 2],
    )
  } finally {
    await server.stop()
  }
})
