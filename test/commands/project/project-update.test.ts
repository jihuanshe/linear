import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { updateCommand } from "../../../src/commands/project/project-update.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"
import {
  type MockGraphQLRequest,
  MockLinearServer,
} from "../../utils/mock_linear_server.ts"

for (
  const fields of [["name", "status"], ["lead", "team", "label"], [
    "start-date",
    "target-date",
    "expect-field",
  ]]
) {
  Deno.test(`project update rejects empty ${fields.join("/")} alongside valid description`, async () => {
    const server = new MockLinearServer()
    await server.start()
    try {
      for (const field of fields) {
        const result = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--allow-all",
            "--quiet",
            "src/main.ts",
            "project",
            "update",
            "550e8400-e29b-41d4-a716-446655440000",
            "--unprotected",
            "--description",
            "Valid",
            `--${field}`,
            "",
            "--json",
          ],
          env: {
            LINEAR_API_KEY: "test-token",
            LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          },
        }).output()
        assertEquals(result.code, 1, new TextDecoder().decode(result.stdout))
        assertEquals(server.graphqlRequests, [])
      }
    } finally {
      await server.stop()
    }
  })
}

Deno.test("project update empty inline description conflicts with file before requests", async () => {
  const server = new MockLinearServer()
  await server.start()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--quiet",
        "src/main.ts",
        "project",
        "update",
        "550e8400-e29b-41d4-a716-446655440000",
        "--unprotected",
        "--description",
        "",
        "--description-file",
        "does-not-exist.md",
        "--json",
      ],
      env: {
        LINEAR_API_KEY: "test-token",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      },
    }).output()
    assertEquals(result.code, 1)
    assertEquals(
      new TextDecoder().decode(result.stdout).includes(
        "Cannot use --description and --description-file together",
      ),
      true,
    )
    assertEquals(server.graphqlRequests, [])
  } finally {
    await server.stop()
  }
})

const originalProject = {
  queryName: "ReadProject",
  response: ({ variables }: MockGraphQLRequest) => ({
    data: {
      organization: { id: "workspace-1", urlKey: "test" },
      project: {
        id: variables.id,
        name: "Original project",
        description: "Original description",
        startDate: null,
        targetDate: null,
        archivedAt: null,
        status: { id: "original-status" },
        lead: null,
        teams: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        labels: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }),
}

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
    "--unprotected",
    "550e8400-e29b-41d4-a716-446655440000",
    "--name",
    "Updated Project Name",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalProject, {
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

// Test project update - description
await cliffySnapshotTest({
  name: "Project Update Command - Update Description",
  meta: import.meta,
  colors: false,
  args: [
    "--unprotected",
    "550e8400-e29b-41d4-a716-446655440001",
    "--description",
    "New project description",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalProject, {
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

// Test project update - status (requires GetProjectStatusesForUpdate)
await cliffySnapshotTest({
  name: "Project Update Command - Update Status",
  meta: import.meta,
  colors: false,
  args: [
    "--unprotected",
    "550e8400-e29b-41d4-a716-446655440002",
    "--status",
    "completed",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalProject, {
      queryName: "GetProjectStatusesForUpdate",
      response: {
        data: {
          projectStatuses: {
            pageInfo: { hasNextPage: false, endCursor: null },
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
    }, {
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

// Test project update - replace labels.
// The UpdateProject mock pins `input.labelIds` to exactly the resolved set, so
// an additive implementation (or a wrong set) would fail to match the mock.
await cliffySnapshotTest({
  name: "Project Update Command - Replace Labels",
  meta: import.meta,
  colors: false,
  args: [
    "--unprotected",
    "550e8400-e29b-41d4-a716-446655440003",
    "--label",
    "Frontend",
    "--label",
    "Backend",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([originalProject, {
      queryName: "GetProjectLabelIdByName",
      variables: { name: "Frontend" },
      response: {
        data: {
          projectLabels: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "project-label-frontend", name: "Frontend" }],
          },
        },
      },
    }, {
      queryName: "GetProjectLabelIdByName",
      variables: { name: "Backend" },
      response: {
        data: {
          projectLabels: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "project-label-backend", name: "Backend" }],
          },
        },
      },
    }, {
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

// Case-insensitive duplicate label names collapse to a single ID.
Deno.test("Project Update Command - dedups case-insensitive labels", async () => {
  const server = new MockLinearServer([originalProject, {
    // No `variables` → matches both "Frontend" and "frontend" lookups.
    queryName: "GetProjectLabelIdByName",
    response: {
      data: {
        projectLabels: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: "project-label-frontend", name: "Frontend" }],
        },
      },
    },
  }, {
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
  }])

  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    await updateCommand.parse([
      "--unprotected",
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
  const server = new MockLinearServer([originalProject, {
    queryName: "GetProjectLabelIdByName",
    variables: { name: "Existing" },
    response: {
      data: {
        projectLabels: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: "project-label-existing", name: "Existing" }],
        },
      },
    },
  }, {
    queryName: "GetProjectLabelIdByName",
    variables: { name: "Missing" },
    response: {
      data: {
        projectLabels: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  }])

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
      "--unprotected",
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
      "--unprotected",
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
  const server = new MockLinearServer([originalProject, {
    queryName: "GetProjectLabelIdByName",
    variables: { name: "Frontend" },
    response: {
      data: {
        projectLabels: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: "project-label-frontend", name: "Frontend" }],
        },
      },
    },
  }, {
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
  }])

  const logs: string[] = []
  const logStub = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "))
  })

  try {
    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    await updateCommand.parse([
      "--unprotected",
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
    await updateCommand.parse([
      "--unprotected",
      "550e8400-e29b-41d4-a716-446655440008",
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
    errorLogs.some((l) =>
      l.includes("At least one update option must be provided")
    ),
    true,
  )
  assertEquals(errorLogs.some((l) => l.includes("--label")), true)
})

Deno.test("Project Update Command - rejects a missing result entity", async () => {
  const server = new MockLinearServer([originalProject, {
    queryName: "UpdateProject",
    response: {
      data: {
        projectUpdate: {
          success: true,
          project: null,
        },
      },
    },
  }])
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
      "--unprotected",
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
      line.includes("Mutation succeeded but returned no object identity")
    ),
    true,
  )
})
