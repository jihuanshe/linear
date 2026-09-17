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
  const { scenario, json } of [
    "sorted",
    "empty",
    "missing cursor",
    "cycle",
    "missing pageInfo",
  ].flatMap((scenario) => [{ scenario, json: false }, { scenario, json: true }])
) {
  Deno.test(`milestone list - complete pagination ${scenario} ${json ? "JSON" : "human"}`, async () => {
    const projectId = "11111111-1111-4111-8111-111111111111"
    const server = new MockLinearServer([{
      queryName: "GetProjectMilestones",
      response: ({ variables }) => {
        const later = variables.after != null
        const entries = scenario === "empty"
          ? []
          : later
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
                    hasNextPage: scenario !== "empty" &&
                      (!later || scenario === "cycle"),
                    endCursor: scenario === "missing cursor"
                      ? null
                      : scenario === "empty" ||
                          (later && scenario !== "cycle")
                      ? "terminal-cursor"
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
          ...(json ? ["-j"] : []),
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
      const success = scenario === "sorted" || scenario === "empty"
      assertEquals(result.code, success ? 0 : 1)
      if (json && success) {
        const connection = JSON.parse(stdout)
        assertEquals(Object.keys(connection).sort(), ["nodes", "pageInfo"])
        assertEquals(connection.pageInfo, {
          hasNextPage: false,
          endCursor: "terminal-cursor",
        })
        assertEquals(
          connection.nodes.map((node: {
            id: string
            name: string
            targetDate: string | null
            sortOrder: number
            project: { id: string; name: string }
          }) => [
            node.id,
            node.name,
            node.targetDate,
            node.sortOrder,
            node.project,
          ]),
          scenario === "empty" ? [] : [
            ["milestone-false-0", "Undated Z", null, 0, {
              id: projectId,
              name: "Project",
            }],
            ["milestone-false-1", "Zulu", "2026-01-01", -1, {
              id: projectId,
              name: "Project",
            }],
            ["milestone-true-0", "Alpha", "2026-01-01", 0, {
              id: projectId,
              name: "Project",
            }],
            ["milestone-true-1", "Earlier", "2025-01-01", -1, {
              id: projectId,
              name: "Project",
            }],
            ["milestone-true-2", "Undated A", null, -2, {
              id: projectId,
              name: "Project",
            }],
          ],
        )
        assertEquals(stderr, "")
      } else if (scenario === "sorted") {
        assertEquals(
          stdout.trim().split("\n").slice(1).map((line) =>
            line.split(/\s+milestone-/)[0].trim()
          ),
          ["Earlier", "Alpha", "Zulu", "Undated A", "Undated Z"],
        )
      } else if (scenario === "empty") {
        assertEquals(stdout.trim(), "No milestones found for this project.")
      } else if (json) {
        const failure = JSON.parse(stdout)
        assertEquals(failure.ok, false)
        assertEquals(failure.effect, "none")
        assertStringIncludes(
          failure.error.message,
          "Incomplete project milestones pagination",
        )
        assertEquals(stderr, "")
      } else {
        assertEquals(stdout, "")
        assertStringIncludes(stderr, "Incomplete project milestones pagination")
      }
      assertEquals(
        server.graphqlRequests.map((request) => request.variables),
        scenario === "empty" || scenario === "missing cursor" ||
          scenario === "missing pageInfo"
          ? [{ projectId, after: null }]
          : [{ projectId, after: null }, { projectId, after: "cursor-1" }],
      )
    } finally {
      await server.stop()
    }
  })
}
