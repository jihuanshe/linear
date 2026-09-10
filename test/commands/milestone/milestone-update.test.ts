import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { updateCommand } from "../../../src/commands/milestone/milestone-update.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"
import {
  type MockGraphQLRequest,
  MockLinearServer,
} from "../../utils/mock_linear_server.ts"

for (
  const [option, value, message] of [
    ["--name", "", "Milestone name cannot be empty"],
    ["--name", " \n", "Milestone name cannot be empty"],
    ["--project", "", "Project cannot be empty"],
    ["--project", " \n", "Project cannot be empty"],
    ...[
      "",
      "2026-02-30",
      "2026-02-29",
      "2100-02-29",
      "2026-04-31",
      "2026-13-01",
    ]
      .map((value) => ["--target-date", value, "Target date must be a valid"]),
  ]
) {
  Deno.test(`milestone rejects invalid input: ${option} ${JSON.stringify(value)}`, async () => {
    const server = new MockLinearServer([])
    try {
      await server.start()
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "milestone",
          "update",
          "milestone-1",
          option,
          value,
          "--description",
          "new",
          "--unprotected",
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
      assertEquals(result.code, 1)
      assertEquals(body.effect, "none")
      assertStringIncludes(body.error.message, message)
      assertEquals(server.graphqlRequests, [])
    } finally {
      await server.stop()
    }
  })
}

const originalMilestone = {
  queryName: "ReadMilestone",
  response: ({ variables }: MockGraphQLRequest) => ({
    data: {
      organization: { id: "workspace-1", urlKey: "test" },
      projectMilestone: {
        id: variables.id,
        name: "Original milestone",
        description: "Original description",
        targetDate: null,
        sortOrder: 10,
        archivedAt: null,
        project: { id: "project-123", name: "Test Project" },
      },
    },
  }),
}

for (const targetDate of ["2028-02-29", "2000-02-29", "2026-04-30"]) {
  Deno.test(`milestone accepts valid calendar date ${targetDate}`, async () => {
    const server = new MockLinearServer([
      originalMilestone,
      {
        queryName: "UpdateProjectMilestone",
        response: ({ variables }: MockGraphQLRequest) => {
          assertEquals(variables.input, { targetDate })
          return {
            data: {
              projectMilestoneUpdate: {
                success: true,
                projectMilestone: { id: "milestone-1", targetDate },
              },
            },
          }
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
          "update",
          "milestone-1",
          "--target-date",
          targetDate,
          "--unprotected",
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
      assertEquals(result.code, 0)
      assertEquals(body.effect, "applied")
      assertEquals(body.data.projectMilestone.targetDate, targetDate)
      assertEquals(server.graphqlRequests.length, 2)
    } finally {
      await server.stop()
    }
  })
}

for (
  const scenario of [
    { name: "clear and repeat", remote: "after", receipt: "", readBack: "" },
    { name: "already empty", remote: "", receipt: "", readBack: "" },
    { name: "whitespace conflict", remote: "after\n", conflict: true },
    {
      name: "receipt mismatch",
      remote: "after",
      receipt: "after",
      readBack: "",
    },
    { name: "read mismatch", remote: "after", receipt: "", readBack: "after" },
    { name: "LF is not empty", remote: "after", receipt: "", readBack: "\n" },
    { name: "read fails", remote: "after", receipt: "", readFailure: true },
  ]
) {
  Deno.test(`Milestone production clear: ${scenario.name}`, async () => {
    const id = "550e8400-e29b-41d4-a716-446655440100"
    const organization = { id: "workspace-1", urlKey: "test" }
    const milestone = {
      id,
      name: "Milestone",
      description: "after",
      archivedAt: null,
      targetDate: null,
      sortOrder: 10,
      project: { id: "project-123", name: "Project" },
    }
    let mutated = false
    const server = new MockLinearServer([
      {
        queryName: "ReadMilestone",
        response: () =>
          mutated && scenario.readFailure
            ? { errors: [{ message: "Read-back unavailable" }] }
            : {
              data: {
                organization,
                projectMilestone: {
                  ...milestone,
                  description: mutated ? scenario.readBack : scenario.remote,
                },
              },
            },
      },
      {
        queryName: "UpdateProjectMilestone",
        response: () => {
          mutated = true
          return {
            data: {
              projectMilestoneUpdate: {
                success: true,
                projectMilestone: {
                  ...milestone,
                  description: scenario.receipt,
                },
              },
            },
          }
        },
      },
    ])
    const path = await Deno.makeTempFile({ suffix: ".json" })
    try {
      await Deno.writeTextFile(
        path,
        JSON.stringify({ organization, projectMilestone: milestone }),
      )
      await server.start()
      const run = async () => {
        const result = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            ...commonDenoArgs,
            "src/main.ts",
            "milestone",
            "update",
            id,
            "--description",
            "",
            "--base-file",
            path,
            "--json",
          ],
          env: {
            LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
            LINEAR_API_KEY: "test-token",
            NO_COLOR: "1",
          },
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output()
        return {
          code: result.code,
          body: JSON.parse(new TextDecoder().decode(result.stdout)),
        }
      }
      const result = await run()
      const unverified = mutated &&
        (scenario.receipt !== "" || scenario.readBack !== "" ||
          scenario.readFailure)
      assertEquals(result.code, scenario.conflict || unverified ? 1 : 0)
      assertEquals(result.body.ok, !scenario.conflict && !unverified)
      assertEquals(result.body.effect, mutated ? "applied" : "none")
      const fields = result.body.fields ?? result.body.error.details.fields
      assertEquals(fields[0].base, "after")
      assertEquals(fields[0].desired, "")
      assertEquals(fields[0].remote, scenario.remote)
      if (mutated) {
        assertEquals(
          result.body.data.projectMilestone.description,
          scenario.receipt,
        )
        const verification = result.body.verification ??
          result.body.error.details.verification
        assertEquals(
          verification.status,
          unverified ? "unverified" : "verified",
        )
        if (!unverified) {
          const repeated = await run()
          assertEquals(repeated.code, 0)
          assertEquals(repeated.body.effect, "none")
        }
      }
      const writes = server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      )
      assertEquals(writes.length, mutated ? 1 : 0)
      if (mutated) {
        assertEquals(writes[0].variables.input, { description: "\n" })
      }
    } finally {
      await server.stop()
      await Deno.remove(path)
    }
  })
}

// Test help output
await cliffySnapshotTest({
  name: "Milestone Update Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs: commonDenoArgs,
  async fn() {
    updateCommand.help({ colors: false })
    await updateCommand.parse()
  },
})

// Test successful milestone update - name only
await cliffySnapshotTest({
  name: "Milestone Update Command - Update Name",
  meta: import.meta,
  colors: false,
  args: ["--unprotected", "milestone-123", "--name", "Updated Milestone Name"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalMilestone, {
      queryName: "UpdateProjectMilestone",
      response: {
        data: {
          projectMilestoneUpdate: {
            success: true,
            projectMilestone: {
              id: "milestone-123",
              name: "Updated Milestone Name",
              targetDate: "2026-03-31",
              sortOrder: 0,
              project: {
                id: "project-123",
                name: "Test Project",
              },
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test milestone update - multiple fields
await cliffySnapshotTest({
  name: "Milestone Update Command - Update Multiple Fields",
  meta: import.meta,
  colors: false,
  args: [
    "--unprotected",
    "milestone-456",
    "--name",
    "Q2 Goals",
    "--description",
    "Second quarter objectives",
    "--target-date",
    "2026-06-30",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalMilestone, {
      queryName: "UpdateProjectMilestone",
      response: {
        data: {
          projectMilestoneUpdate: {
            success: true,
            projectMilestone: {
              id: "milestone-456",
              name: "Q2 Goals",
              targetDate: "2026-06-30",
              sortOrder: 1,
              project: {
                id: "project-789",
                name: "Another Project",
              },
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test milestone update - sort order only
await cliffySnapshotTest({
  name: "Milestone Update Command - Update Sort Order",
  meta: import.meta,
  colors: false,
  args: ["--unprotected", "milestone-sort", "--sort-order", "5"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalMilestone, {
      queryName: "UpdateProjectMilestone",
      response: {
        data: {
          projectMilestoneUpdate: {
            success: true,
            projectMilestone: {
              id: "milestone-sort",
              name: "Sorted Milestone",
              targetDate: "2026-06-15",
              sortOrder: 5,
              project: {
                id: "project-123",
                name: "Test Project",
              },
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test milestone update - sort order zero (guards against truthiness-check regression)
await cliffySnapshotTest({
  name: "Milestone Update Command - Update Sort Order Zero",
  meta: import.meta,
  colors: false,
  args: ["--unprotected", "milestone-zero", "--sort-order", "0"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalMilestone, {
      queryName: "UpdateProjectMilestone",
      response: {
        data: {
          projectMilestoneUpdate: {
            success: true,
            projectMilestone: {
              id: "milestone-zero",
              name: "First Milestone",
              targetDate: "2026-01-15",
              sortOrder: 0,
              project: {
                id: "project-123",
                name: "Test Project",
              },
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test milestone update - target date only
await cliffySnapshotTest({
  name: "Milestone Update Command - Update Target Date",
  meta: import.meta,
  colors: false,
  args: ["--unprotected", "milestone-789", "--target-date", "2026-12-31"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalMilestone, {
      queryName: "UpdateProjectMilestone",
      response: {
        data: {
          projectMilestoneUpdate: {
            success: true,
            projectMilestone: {
              id: "milestone-789",
              name: "Existing Milestone",
              targetDate: "2026-12-31",
              sortOrder: 2,
              project: {
                id: "project-999",
                name: "Final Project",
              },
            },
          },
        },
      },
    }])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})
