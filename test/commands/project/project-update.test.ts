import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { updateCommand } from "../../../src/commands/project/project-update.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

// Test help output
await cliffySnapshotTest({
  name: "Project Update Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs: commonDenoArgs,
  async fn() {
    updateCommand.help({ colors: false })
    await updateCommand.parse()
  },
})

// Test project update - name only
await cliffySnapshotTest({
  name: "Project Update Command - Update Name",
  meta: import.meta,
  colors: false,
  args: [
    "550e8400-e29b-41d4-a716-446655440000",
    "--name",
    "Updated Project Name",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "UpdateProject",
        response: {
          data: {
            projectUpdate: {
              success: true,
              project: {
                id: "550e8400-e29b-41d4-a716-446655440000",
                slugId: "updated-proj",
                name: "Updated Project Name",
                description: null,
                url: "https://linear.app/test/project/updated-proj",
                updatedAt: "2024-01-20T15:30:00Z",
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

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test project update - description
await cliffySnapshotTest({
  name: "Project Update Command - Update Description",
  meta: import.meta,
  colors: false,
  args: [
    "550e8400-e29b-41d4-a716-446655440001",
    "--description",
    "New project description",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "UpdateProject",
        response: {
          data: {
            projectUpdate: {
              success: true,
              project: {
                id: "550e8400-e29b-41d4-a716-446655440001",
                slugId: "proj-desc",
                name: "Test Project",
                description: "New project description",
                url: "https://linear.app/test/project/proj-desc",
                updatedAt: "2024-01-20T15:30:00Z",
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

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test project update - status (requires GetProjectStatuses)
await cliffySnapshotTest({
  name: "Project Update Command - Update Status",
  meta: import.meta,
  colors: false,
  args: [
    "550e8400-e29b-41d4-a716-446655440002",
    "--status",
    "completed",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjectStatuses",
        response: {
          data: {
            projectStatuses: {
              nodes: [
                {
                  id: "status-completed-id",
                  name: "Completed",
                  type: "completed",
                },
              ],
            },
          },
        },
      },
      {
        queryName: "UpdateProject",
        response: {
          data: {
            projectUpdate: {
              success: true,
              project: {
                id: "550e8400-e29b-41d4-a716-446655440002",
                slugId: "proj-status",
                name: "Test Project",
                description: null,
                url: "https://linear.app/test/project/proj-status",
                updatedAt: "2024-01-20T15:30:00Z",
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

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test project update - replace labels.
// The UpdateProject mock pins `input.labelIds` to exactly the resolved set, so
// an additive implementation (or a wrong set) would fail to match the mock.
await cliffySnapshotTest({
  name: "Project Update Command - Replace Labels",
  meta: import.meta,
  colors: false,
  args: [
    "550e8400-e29b-41d4-a716-446655440003",
    "--label",
    "Frontend",
    "--label",
    "Backend",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjectLabelIdByName",
        variables: { name: "Frontend" },
        response: {
          data: {
            projectLabels: {
              nodes: [{ id: "project-label-frontend", name: "Frontend" }],
            },
          },
        },
      },
      {
        queryName: "GetProjectLabelIdByName",
        variables: { name: "Backend" },
        response: {
          data: {
            projectLabels: {
              nodes: [{ id: "project-label-backend", name: "Backend" }],
            },
          },
        },
      },
      {
        queryName: "UpdateProject",
        variables: {
          id: "550e8400-e29b-41d4-a716-446655440003",
          input: {
            labelIds: ["project-label-frontend", "project-label-backend"],
          },
        },
        response: {
          data: {
            projectUpdate: {
              success: true,
              project: {
                id: "550e8400-e29b-41d4-a716-446655440003",
                slugId: "proj-labels",
                name: "Test Project",
                description: null,
                url: "https://linear.app/test/project/proj-labels",
                updatedAt: "2024-01-20T15:30:00Z",
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

      await updateCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

Deno.test("Project Update Command - adds teams without replacing existing teams", async () => {
  const server = new MockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ARCH" },
      response: { data: { teams: { nodes: [{ id: "team-arch" }] } } },
    },
    {
      queryName: "GetProjectTeams",
      variables: { id: "550e8400-e29b-41d4-a716-446655440010" },
      response: {
        data: {
          project: {
            teams: {
              nodes: [{ id: "team-existing" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    {
      queryName: "UpdateProject",
      variables: {
        id: "550e8400-e29b-41d4-a716-446655440010",
        input: { teamIds: ["team-existing", "team-arch"] },
      },
      response: {
        data: {
          projectUpdate: {
            success: true,
            project: {
              id: "550e8400-e29b-41d4-a716-446655440010",
              slugId: "proj-add-team",
              name: "Test Project",
              description: null,
              url: "https://linear.app/test/project/proj-add-team",
              updatedAt: "2024-01-20T15:30:00Z",
            },
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
    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    await updateCommand.parse([
      "550e8400-e29b-41d4-a716-446655440010",
      "--add-team",
      "ARCH",
    ])
  } finally {
    logStub.restore()
    await server.stop()
    Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
    Deno.env.delete("LINEAR_API_KEY")
  }

  assertEquals(logs.some((line) => line.includes("✓ Updated project")), true)
})

Deno.test("Project Update Command - preserves all paginated project teams", async () => {
  const projectId = "550e8400-e29b-41d4-a716-446655440012"
  const server = new MockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ARCH" },
      response: { data: { teams: { nodes: [{ id: "team-arch" }] } } },
    },
    {
      queryName: "GetProjectTeams",
      variables: { id: projectId, after: null },
      response: {
        data: {
          project: {
            teams: {
              nodes: [{ id: "team-existing-1" }, { id: "team-existing-2" }],
              pageInfo: { hasNextPage: true, endCursor: "team-cursor-1" },
            },
          },
        },
      },
    },
    {
      queryName: "GetProjectTeams",
      variables: { id: projectId, after: "team-cursor-1" },
      response: {
        data: {
          project: {
            teams: {
              nodes: [{ id: "team-existing-3" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    {
      queryName: "UpdateProject",
      variables: {
        id: projectId,
        input: {
          teamIds: [
            "team-existing-1",
            "team-existing-2",
            "team-existing-3",
            "team-arch",
          ],
        },
      },
      response: {
        data: {
          projectUpdate: {
            success: true,
            project: {
              id: projectId,
              slugId: "proj-paginated-teams",
              name: "Test Project",
              description: null,
              url: "https://linear.app/test/project/proj-paginated-teams",
              updatedAt: "2024-01-20T15:30:00Z",
            },
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
    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    await updateCommand.parse([projectId, "--add-team", "ARCH"])
  } finally {
    logStub.restore()
    await server.stop()
    Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
    Deno.env.delete("LINEAR_API_KEY")
  }

  assertEquals(logs.some((line) => line.includes("✓ Updated project")), true)
})

Deno.test("Project Update Command - rejects replace and add team flags together", async () => {
  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  try {
    await updateCommand.parse([
      "550e8400-e29b-41d4-a716-446655440011",
      "--team",
      "JHS",
      "--add-team",
      "ARCH",
    ])
  } catch {
    // expected
  } finally {
    errorStub.restore()
    exitStub.restore()
  }

  assertEquals(
    errorLogs.some((line) =>
      line.includes("Cannot use --team and --add-team together")
    ),
    true,
  )
})

// Case-insensitive duplicate label names collapse to a single ID.
Deno.test("Project Update Command - dedups case-insensitive labels", async () => {
  const server = new MockLinearServer([
    {
      // No `variables` → matches both "Frontend" and "frontend" lookups.
      queryName: "GetProjectLabelIdByName",
      response: {
        data: {
          projectLabels: {
            nodes: [{ id: "project-label-frontend", name: "Frontend" }],
          },
        },
      },
    },
    {
      queryName: "UpdateProject",
      variables: {
        id: "550e8400-e29b-41d4-a716-446655440004",
        input: { labelIds: ["project-label-frontend"] },
      },
      response: {
        data: {
          projectUpdate: {
            success: true,
            project: {
              id: "550e8400-e29b-41d4-a716-446655440004",
              slugId: "proj-dedup",
              name: "Test Project",
              description: null,
              url: "https://linear.app/test/project/proj-dedup",
              updatedAt: "2024-01-20T15:30:00Z",
            },
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
    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    await updateCommand.parse([
      "550e8400-e29b-41d4-a716-446655440004",
      "--label",
      "Frontend",
      "--label",
      "frontend",
    ])
  } finally {
    logStub.restore()
    await server.stop()
    Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
    Deno.env.delete("LINEAR_API_KEY")
  }

  // Success message only appears if the UpdateProject mock matched the deduped set.
  assertEquals(logs.some((l) => l.includes("✓ Updated project")), true)
})

// An unknown --label fails before the update mutation (no UpdateProject mock is
// configured, so a mutation attempt would surface a different error).
Deno.test("Project Update Command - rejects an unknown label before mutating", async () => {
  const server = new MockLinearServer([
    {
      queryName: "GetProjectLabelIdByName",
      variables: { name: "Existing" },
      response: {
        data: {
          projectLabels: {
            nodes: [{ id: "project-label-existing", name: "Existing" }],
          },
        },
      },
    },
    {
      queryName: "GetProjectLabelIdByName",
      variables: { name: "Missing" },
      response: { data: { projectLabels: { nodes: [] } } },
    },
  ])

  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  let exited = false
  try {
    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    await updateCommand.parse([
      "550e8400-e29b-41d4-a716-446655440005",
      "--label",
      "Existing",
      "--label",
      "Missing",
    ])
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "EXIT") throw e
    exited = true
  } finally {
    errorStub.restore()
    exitStub.restore()
    await server.stop()
    Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
    Deno.env.delete("LINEAR_API_KEY")
  }

  assertEquals(exited, true)
  assertEquals(
    errorLogs.some((l) => l.includes("Project label not found: Missing")),
    true,
  )
})

// An empty/whitespace label is rejected as a validation error, not treated as
// a request to clear labels.
Deno.test("Project Update Command - rejects an empty label", async () => {
  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  let exited = false
  try {
    await updateCommand.parse([
      "550e8400-e29b-41d4-a716-446655440006",
      "--label",
      "   ",
    ])
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "EXIT") throw e
    exited = true
  } finally {
    errorStub.restore()
    exitStub.restore()
  }

  assertEquals(exited, true)
  assertEquals(
    errorLogs.some((l) => l.includes("Project label cannot be empty")),
    true,
  )
})

// --label alone satisfies the "at least one update option" requirement.
Deno.test("Project Update Command - label alone is a valid update", async () => {
  const server = new MockLinearServer([
    {
      queryName: "GetProjectLabelIdByName",
      variables: { name: "Frontend" },
      response: {
        data: {
          projectLabels: {
            nodes: [{ id: "project-label-frontend", name: "Frontend" }],
          },
        },
      },
    },
    {
      queryName: "UpdateProject",
      variables: {
        id: "550e8400-e29b-41d4-a716-446655440007",
        input: { labelIds: ["project-label-frontend"] },
      },
      response: {
        data: {
          projectUpdate: {
            success: true,
            project: {
              id: "550e8400-e29b-41d4-a716-446655440007",
              slugId: "proj-label-only",
              name: "Test Project",
              description: null,
              url: "https://linear.app/test/project/proj-label-only",
              updatedAt: "2024-01-20T15:30:00Z",
            },
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
    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    await updateCommand.parse([
      "550e8400-e29b-41d4-a716-446655440007",
      "--label",
      "Frontend",
    ])
  } finally {
    logStub.restore()
    await server.stop()
    Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
    Deno.env.delete("LINEAR_API_KEY")
  }

  assertEquals(logs.some((l) => l.includes("✓ Updated project")), true)
})

// No options at all still fails, and the suggestion now mentions --label.
Deno.test("Project Update Command - requires at least one option", async () => {
  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  let exited = false
  try {
    await updateCommand.parse(["550e8400-e29b-41d4-a716-446655440008"])
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "EXIT") throw e
    exited = true
  } finally {
    errorStub.restore()
    exitStub.restore()
  }

  assertEquals(exited, true)
  assertEquals(
    errorLogs.some((l) =>
      l.includes("At least one update option must be provided")
    ),
    true,
  )
  assertEquals(errorLogs.some((l) => l.includes("--label")), true)
})

Deno.test("Project Update Command - rejects a missing result entity", async () => {
  const server = new MockLinearServer([
    {
      queryName: "UpdateProject",
      response: {
        data: {
          projectUpdate: {
            success: true,
            project: null,
          },
        },
      },
    },
  ])
  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  try {
    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    await updateCommand.parse([
      "550e8400-e29b-41d4-a716-446655440009",
      "--name",
      "Updated Project",
    ])
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "EXIT") throw error
  } finally {
    exitStub.restore()
    errorStub.restore()
    await server.stop()
    Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
    Deno.env.delete("LINEAR_API_KEY")
  }

  assertEquals(
    errorLogs.some((line) =>
      line.includes("Project update returned no project")
    ),
    true,
  )
})
