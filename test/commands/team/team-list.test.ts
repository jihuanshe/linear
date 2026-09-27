import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals } from "@std/assert"
import { stubDate } from "../../utils/stub-date.ts"
import { listCommand } from "../../../src/commands/team/team-list.ts"
import { fromFileUrl } from "@std/path"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

// Common Deno args for permissions
const denoArgs = ["--allow-all", "--quiet"]

// Test with mock server - Teams list
await cliffySnapshotTest({
  name: "Team List Command - With Mock Teams",
  meta: import.meta,
  colors: false,
  args: [],
  denoArgs,
  async fn() {
    using _date = stubDate("2025-08-17T15:30:00Z")
    const server = new MockLinearServer([
      {
        queryName: "GetTeams",
        variables: { filter: undefined, first: 100, after: undefined },
        response: {
          data: {
            teams: {
              nodes: [
                {
                  id: "team-1",
                  name: "Backend Team",
                  key: "BACKEND",
                  description: "Core backend development team",
                  icon: "⚙️",
                  color: "#3b82f6",
                  cyclesEnabled: true,
                  createdAt: "2023-12-01T10:00:00Z",
                  updatedAt: "2024-01-20T15:30:00Z",
                  archivedAt: null,
                  organization: {
                    id: "org-1",
                    name: "Acme Corp",
                  },
                },
                {
                  id: "team-2",
                  name: "Frontend Team",
                  key: "FRONTEND",
                  description: "User interface development team",
                  icon: "🎨",
                  color: "#ef4444",
                  cyclesEnabled: false,
                  createdAt: "2023-11-15T14:00:00Z",
                  updatedAt: "2024-01-18T11:15:00Z",
                  archivedAt: null,
                  organization: {
                    id: "org-1",
                    name: "Acme Corp",
                  },
                },
                {
                  id: "team-3",
                  name: "Security Team",
                  key: "SEC",
                  description: "Security and compliance team",
                  icon: "🔒",
                  color: "#10b981",
                  cyclesEnabled: true,
                  createdAt: "2023-10-01T09:00:00Z",
                  updatedAt: "2024-01-22T16:45:00Z",
                  archivedAt: null,
                  organization: {
                    id: "org-1",
                    name: "Acme Corp",
                  },
                },
                {
                  id: "team-4",
                  name: "Archived Team",
                  key: "ARCH",
                  description: "This team is archived",
                  icon: null,
                  color: "#64748b",
                  cyclesEnabled: false,
                  createdAt: "2023-08-01T08:00:00Z",
                  updatedAt: "2023-12-01T10:00:00Z",
                  archivedAt: "2023-12-01T10:00:00Z",
                  organization: {
                    id: "org-1",
                    name: "Acme Corp",
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

// Test with empty teams list
await cliffySnapshotTest({
  name: "Team List Command - No Teams Found",
  meta: import.meta,
  colors: false,
  args: [],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetTeams",
        variables: { filter: undefined, first: 100, after: undefined },
        response: {
          data: {
            teams: {
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

await cliffySnapshotTest({
  name: "Team List Command - Empty JSON Connection",
  meta: import.meta,
  colors: false,
  args: ["--json"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([{
      queryName: "GetTeams",
      variables: { filter: undefined, first: 100, after: undefined },
      response: {
        data: {
          teams: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }])
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
  name: "Team List Command - JSON Limit Preserves API Pagination",
  meta: import.meta,
  colors: false,
  args: ["--json", "--limit", "1"],
  denoArgs,
  async fn() {
    const team = (id: string, name: string, key: string) => ({
      id,
      name,
      key,
      description: null,
      icon: null,
      color: null,
      cyclesEnabled: false,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      archivedAt: null,
      organization: { id: "org-1", name: "Acme" },
    })
    const server = new MockLinearServer([{
      queryName: "GetTeams",
      variables: { filter: undefined, first: 1, after: undefined },
      response: {
        data: {
          teams: {
            nodes: [team("team-z", "Zulu", "Z")],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      },
    }])
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
  name: "Team List Command - Pagination (Multiple Pages)",
  meta: import.meta,
  colors: false,
  args: [],
  denoArgs,
  async fn() {
    using _date = stubDate("2025-08-17T15:30:00Z")
    const server = new MockLinearServer([
      // First page
      {
        queryName: "GetTeams",
        variables: { filter: undefined, first: 100, after: undefined },
        response: {
          data: {
            teams: {
              nodes: [
                {
                  id: "team-page1-1",
                  name: "Alpha Team",
                  key: "ALPHA",
                  description: "First team on page 1",
                  icon: "🅰️",
                  color: "#3b82f6",
                  cyclesEnabled: true,
                  createdAt: "2024-01-01T10:00:00Z",
                  updatedAt: "2024-06-15T12:00:00Z",
                  archivedAt: null,
                  organization: {
                    id: "org-1",
                    name: "Test Org",
                  },
                },
                {
                  id: "team-page1-2",
                  name: "Beta Team",
                  key: "BETA",
                  description: "Second team on page 1",
                  icon: "🅱️",
                  color: "#ef4444",
                  cyclesEnabled: false,
                  createdAt: "2024-01-02T10:00:00Z",
                  updatedAt: "2024-06-16T12:00:00Z",
                  archivedAt: null,
                  organization: {
                    id: "org-1",
                    name: "Test Org",
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
        queryName: "GetTeams",
        variables: {
          filter: undefined,
          first: 100,
          after: "cursor-page-1-end",
        },
        response: {
          data: {
            teams: {
              nodes: [
                {
                  id: "team-page2-1",
                  name: "Gamma Team",
                  key: "GAMMA",
                  description: "First team on page 2",
                  icon: "🔤",
                  color: "#10b981",
                  cyclesEnabled: true,
                  createdAt: "2024-01-03T10:00:00Z",
                  updatedAt: "2024-06-17T12:00:00Z",
                  archivedAt: null,
                  organization: {
                    id: "org-1",
                    name: "Test Org",
                  },
                },
                {
                  id: "team-page2-2",
                  name: "Delta Team",
                  key: "DELTA",
                  description: "Second team on page 2",
                  icon: "🔺",
                  color: "#f59e0b",
                  cyclesEnabled: false,
                  createdAt: "2024-01-04T10:00:00Z",
                  updatedAt: "2024-06-18T12:00:00Z",
                  archivedAt: null,
                  organization: {
                    id: "org-1",
                    name: "Test Org",
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

Deno.test("team list --limit selects the same teams for human and JSON output", async () => {
  const team = (id: string, name: string, key: string) => ({
    id,
    name,
    key,
    description: null,
    icon: null,
    color: null,
    cyclesEnabled: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    archivedAt: null,
    organization: { id: "org-1", name: "Acme" },
  })
  const pageInfo = { hasNextPage: true, endCursor: "cursor-1" }
  // Only the bounded first page is mocked: reading every page and slicing
  // after the sort would request first: 100 and fail against this server.
  const server = new MockLinearServer([{
    queryName: "GetTeams",
    variables: { filter: undefined, first: 2, after: undefined },
    response: {
      data: {
        teams: {
          nodes: [team("team-z", "Zulu", "Z"), team("team-a", "Alpha", "A")],
          pageInfo,
        },
      },
    },
  }])
  await server.start()
  try {
    const run = async (extra: string[]) => {
      const output = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-all",
          "--quiet",
          fromFileUrl(new URL("../../../src/main.ts", import.meta.url)),
          "team",
          "list",
          "--limit",
          "2",
          ...extra,
        ],
        env: {
          NO_COLOR: "1",
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
    const json = await run(["--json"])
    assertEquals(json.code, 0, json.stdout + json.stderr)
    assertEquals(json.stderr, "")
    const parsed = JSON.parse(json.stdout)
    assertEquals(
      parsed.nodes.map((node: { key: string }) => node.key),
      ["A", "Z"],
    )
    assertEquals(parsed.pageInfo, pageInfo)

    const human = await run([])
    assertEquals(human.code, 0, human.stdout + human.stderr)
    assertEquals(
      human.stdout.trimEnd().split("\n").slice(1).map((line) =>
        line.split(" ")[0]
      ),
      ["A", "Z"],
    )
    assertEquals(
      human.stderr,
      "Showing the first 2 teams; more exist. Use --limit 0 to fetch all pages.\n",
    )
    assertEquals(
      server.graphqlRequests.map(({ variables }) => variables.first),
      [2, 2],
    )
  } finally {
    await server.stop()
  }
})
