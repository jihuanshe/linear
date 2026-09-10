import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { listCommand } from "../../../src/commands/milestone/milestone-list.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

// Test help output
await cliffySnapshotTest({
  name: "Milestone List Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs: commonDenoArgs,
  async fn() {
    listCommand.help({ colors: false })
    await listCommand.parse()
  },
})

// Test with mock server - Milestones list
await cliffySnapshotTest({
  name: "Milestone List Command - With Mock Milestones",
  meta: import.meta,
  colors: false,
  args: ["--project", "project-123"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjectIdByName",
        response: {
          data: {
            projects: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "GetProjectIdBySlugId",
        response: {
          data: {
            projects: {
              nodes: [{ id: "project-123" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "GetProjectMilestones",
        variables: { projectId: "project-123" },
        response: {
          data: {
            project: {
              id: "project-123",
              name: "Test Project",
              projectMilestones: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "milestone-1",
                    name: "Infrastructure Foundation",
                    targetDate: "2026-01-31",
                    sortOrder: 1,
                    project: {
                      id: "project-123",
                      name: "Test Project",
                    },
                  },
                  {
                    id: "milestone-2",
                    name: "Observation Phase",
                    targetDate: "2026-02-28",
                    sortOrder: 2,
                    project: {
                      id: "project-123",
                      name: "Test Project",
                    },
                  },
                  {
                    id: "milestone-3",
                    name: "Safe Enablement",
                    targetDate: "2026-03-31",
                    sortOrder: 3,
                    project: {
                      id: "project-123",
                      name: "Test Project",
                    },
                  },
                ],
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

// Test with empty milestones list
await cliffySnapshotTest({
  name: "Milestone List Command - No Milestones Found",
  meta: import.meta,
  colors: false,
  args: ["--project", "project-456"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjectIdByName",
        response: {
          data: {
            projects: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "GetProjectIdBySlugId",
        response: {
          data: {
            projects: {
              nodes: [{ id: "project-456" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "GetProjectMilestones",
        variables: { projectId: "project-456" },
        response: {
          data: {
            project: {
              id: "project-456",
              name: "Empty Project",
              projectMilestones: {
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

for (
  const scenario of ["sorted", "missing cursor", "cycle", "missing pageInfo"]
) {
  Deno.test(`milestone list - complete pagination ${scenario}`, async () => {
    const projectId = "11111111-1111-4111-8111-111111111111"
    const server = new MockLinearServer([{
      queryName: "GetProjectMilestones",
      response: ({ variables }) => {
        const later = variables.after != null
        const entries = later
          ? [["Alpha", "2026-01-01"], ["Earlier", "2025-01-01"], [
            "Undated A",
            null,
          ]]
          : [["Undated Z", null], ["Zulu", "2026-01-01"]]
        return {
          data: {
            project: {
              id: projectId,
              name: "Project",
              projectMilestones: {
                nodes: entries.map(([name, targetDate], index) => ({
                  id: `milestone-${later}-${index}`,
                  name,
                  targetDate,
                  sortOrder: -index,
                  project: { id: projectId, name: "Project" },
                })),
                ...(scenario === "missing pageInfo" ? {} : {
                  pageInfo: {
                    hasNextPage: !later || scenario === "cycle",
                    endCursor: scenario === "missing cursor"
                      ? null
                      : later && scenario !== "cycle"
                      ? null
                      : "cursor-1",
                  },
                }),
              },
            },
          },
        }
      },
    }])
    try {
      await server.start()
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "milestone",
          "list",
          "--project",
          projectId,
        ],
        env: {
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          LINEAR_API_KEY: "test-token",
          NO_COLOR: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output()
      const stdout = new TextDecoder().decode(result.stdout)
      const stderr = new TextDecoder().decode(result.stderr)
      assertEquals(result.code, scenario === "sorted" ? 0 : 1)
      if (scenario === "sorted") {
        assertEquals(
          stdout.trim().split("\n").slice(1).map((line) =>
            line.split(/\s+milestone-/)[0].trim()
          ),
          ["Earlier", "Alpha", "Zulu", "Undated A", "Undated Z"],
        )
      } else {
        assertEquals(stdout, "")
        assertStringIncludes(stderr, "Incomplete project milestones pagination")
      }
      assertEquals(
        server.graphqlRequests.map((request) => request.variables),
        scenario === "missing cursor" || scenario === "missing pageInfo"
          ? [{ projectId, after: null }]
          : [{ projectId, after: null }, { projectId, after: "cursor-1" }],
      )
    } finally {
      await server.stop()
    }
  })
}
