import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { createCommand } from "../../../src/commands/milestone/milestone-create.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

for (
  const [targetDate, valid] of [
    ["2028-02-29", true],
    ["2000-02-29", true],
    ["2026-04-30", true],
    ["2026-02-29", false],
    ["2100-02-29", false],
    ["2026-04-31", false],
    ["2026-13-01", false],
    ["2026-1-01", false],
    ["", false],
  ] as const
) {
  Deno.test(`milestone create validates real calendar date ${JSON.stringify(targetDate)}`, async () => {
    const projectId = "abcdef01-2345-4678-9abc-def012345678"
    const server = new MockLinearServer([
      {
        queryName: "CreateProjectMilestone",
        response: {
          data: {
            projectMilestoneCreate: {
              success: true,
              projectMilestone: {
                id: "milestone",
                name: "Release",
                targetDate,
                project: { id: projectId, name: "Project" },
              },
            },
          },
        },
      },
    ])
    try {
      await server.start()
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "milestone",
          "create",
          "--project",
          projectId,
          "--name",
          "Release",
          "--target-date",
          targetDate,
          "--json",
        ],
        env: {
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          LINEAR_API_KEY: "test-token",
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const body = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(result.code, valid ? 0 : 1, JSON.stringify(body))
      if (valid) {
        assertEquals(body.data.projectMilestone.targetDate, targetDate)
        assertEquals(
          server.graphqlRequests.map((request) => request.variables),
          [{ input: { projectId, name: "Release", targetDate } }],
        )
      } else {
        assertEquals(body.effect, "none")
        assertStringIncludes(body.error.message, "valid calendar date")
        assertEquals(server.graphqlRequests, [])
      }
    } finally {
      await server.stop()
    }
  })
}

// Test successful milestone creation
await cliffySnapshotTest({
  name: "Milestone Create Command - Success",
  meta: import.meta,
  colors: false,
  args: [
    "--project",
    "project-123",
    "--name",
    "Q1 Goals",
    "--description",
    "First quarter objectives",
    "--target-date",
    "2026-03-31",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjectIdByName",
        response: {
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      },
      {
        queryName: "GetProjectIdBySlugId",
        response: {
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "project-123" }],
            },
          },
        },
      },
      {
        queryName: "CreateProjectMilestone",
        response: {
          data: {
            projectMilestoneCreate: {
              success: true,
              projectMilestone: {
                id: "milestone-new-1",
                name: "Q1 Goals",
                targetDate: "2026-03-31",
                project: {
                  id: "project-123",
                  name: "Test Project",
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

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test milestone creation without optional fields
await cliffySnapshotTest({
  name: "Milestone Create Command - Minimal Fields",
  meta: import.meta,
  colors: false,
  args: [
    "--project",
    "project-456",
    "--name",
    "Simple Milestone",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjectIdByName",
        response: {
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      },
      {
        queryName: "GetProjectIdBySlugId",
        response: {
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "project-456" }],
            },
          },
        },
      },
      {
        queryName: "CreateProjectMilestone",
        response: {
          data: {
            projectMilestoneCreate: {
              success: true,
              projectMilestone: {
                id: "milestone-new-2",
                name: "Simple Milestone",
                targetDate: null,
                project: {
                  id: "project-456",
                  name: "Another Project",
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

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// #221: --project also accepts an exact project name
await cliffySnapshotTest({
  name: "Milestone Create Command - Resolves Project by Name",
  meta: import.meta,
  colors: false,
  args: [
    "--project",
    "Tech Debt",
    "--name",
    "Y26 Q2",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjectIdByName",
        variables: { name: "Tech Debt" },
        response: {
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "project-tech-debt-uuid" }],
            },
          },
        },
      },
      {
        queryName: "CreateProjectMilestone",
        variables: {
          input: {
            projectId: "project-tech-debt-uuid",
            name: "Y26 Q2",
          },
        },
        response: {
          data: {
            projectMilestoneCreate: {
              success: true,
              projectMilestone: {
                id: "milestone-new-q2",
                name: "Y26 Q2",
                targetDate: null,
                project: {
                  id: "project-tech-debt-uuid",
                  name: "Tech Debt",
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

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})
