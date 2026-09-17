import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { viewCommand } from "../../../src/commands/project/project-view.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

// Common Deno args for permissions
const denoArgs = ["--allow-all", "--quiet"]

for (const flag of ["--web", "--app"]) {
  Deno.test(`project view ${flag} resolves the project before opening`, async () => {
    const id = "abcdef01-2345-4678-9abc-def012345678"
    const url = "https://linear.app/actual/project/release-project/overview"
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "GetProjectIdByName",
        variables: { name: "Release Project" },
        response: {
          data: {
            projects: {
              nodes: [{ id }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "BrowserProject",
        variables: { id },
        response: { data: { project: { url } } },
      },
    ], { LINEAR_WORKSPACE: "test" })
    const OriginalCommand = Deno.Command
    const launches: Deno.CommandOptions[] = []
    const command = stub(Deno, "Command", (...args: unknown[]) => {
      const [executable, options] = args as ConstructorParameters<
        typeof OriginalCommand
      >
      if (executable === "git") return new OriginalCommand(executable, options)
      launches.push(options ?? {})
      return new OriginalCommand(Deno.execPath(), {
        args: ["eval", ""],
        stdout: "null",
        stderr: "null",
      })
    })
    const log = stub(console, "log", () => {})
    try {
      await viewCommand.parse(["Release Project", flag])
      assertEquals(server.graphqlRequests.length, 2)
      assertEquals(launches.length, 1)
      assertEquals(
        launches[0].args?.includes(url),
        true,
      )
    } finally {
      log.restore()
      command.restore()
      await cleanup()
    }
  })
}

for (
  const scenario of [
    "UUID",
    "name",
    "slug",
    "ambiguous",
    "read-failure",
    "missing",
  ]
) {
  Deno.test(`project view resolves ${scenario} to a stable target`, async () => {
    const id = "abcdef01-2345-4678-9abc-def012345678"
    const pageInfo = { hasNextPage: false, endCursor: null }
    const server = new MockLinearServer([
      {
        queryName: "GetProjectIdByName",
        response: scenario === "read-failure"
          ? { errors: [{ message: "Project lookup unavailable" }] }
          : {
            data: {
              projects: {
                nodes: scenario === "name"
                  ? [{ id }]
                  : scenario === "ambiguous"
                  ? [{ id }, { id: "other" }]
                  : [],
                pageInfo,
              },
            },
          },
      },
      {
        queryName: "GetProjectIdBySlugId",
        response: {
          data: {
            projects: { nodes: scenario === "slug" ? [{ id }] : [], pageInfo },
          },
        },
      },
      {
        queryName: "GetProjectDetails",
        response: {
          data: {
            organization: { id: "workspace", urlKey: "test" },
            project: {
              id,
              name: "Release",
              teams: { nodes: [], pageInfo },
              labels: { nodes: [], pageInfo },
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
          ...denoArgs,
          "src/main.ts",
          "project",
          "view",
          scenario === "UUID" ? id.toUpperCase() : "Release",
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
      const success = ["UUID", "name", "slug"].includes(scenario)
      assertEquals(result.code, success ? 0 : 1, JSON.stringify(body))
      assertEquals(
        server.graphqlRequests.filter((request) =>
          request.query.includes("query GetProjectDetails")
        ).map((request) => request.variables),
        success ? [{ id, includeContent: true }] : [],
      )
      if (!success) {
        assertStringIncludes(
          body.error.message,
          scenario === "ambiguous"
            ? "ambiguous"
            : scenario === "missing"
            ? "not found"
            : "Project lookup unavailable",
        )
      }
      if (scenario === "UUID") assertEquals(server.graphqlRequests.length, 1)
    } finally {
      await server.stop()
    }
  })
}

// Test help output
await snapshotTest({
  name: "Project View Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs,
  async fn() {
    viewCommand.help({ colors: false })
    await viewCommand.parse()
  },
})

// Test with mock server - Project details
await snapshotTest({
  name: "Project View Command - With Project Details",
  meta: import.meta,
  colors: false,
  args: ["project-123"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjectIdByName",
        variables: { name: "project-123" },
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
        queryName: "GetProjectDetails",
        variables: { id: "project-123", includeContent: true },
        response: {
          data: {
            organization: { id: "workspace-1", urlKey: "test" },
            project: {
              id: "project-123",
              content:
                "# Rollout\n\nEnable the new login page for the pilot team.",
              name: "Authentication System Redesign",
              description:
                "Complete overhaul of the authentication system to improve security and user experience.\n\n## Goals\n- Implement OAuth 2.0 / OpenID Connect\n- Add multi-factor authentication\n- Improve password reset flow\n- Add social login options\n\n## Technical Requirements\n- JWT tokens with proper rotation\n- Rate limiting on auth endpoints\n- Audit logging for security events\n- GDPR compliance for user data",
              slugId: "auth-redesign-2024",
              icon: "🔐",
              color: "#3b82f6",
              status: {
                id: "status-started",
                name: "In Progress",
                color: "#f59e0b",
              },
              creator: {
                name: "john.admin",
                displayName: "John Admin",
              },
              lead: {
                name: "jane.lead",
                displayName: "Jane Lead",
              },
              priority: 2,
              health: "onTrack",
              startDate: "2024-01-15",
              targetDate: "2024-04-30",
              startedAt: "2024-01-16T09:00:00Z",
              completedAt: null,
              canceledAt: null,
              updatedAt: "2024-01-25T14:30:00Z",
              createdAt: "2024-01-10T10:00:00Z",
              url: "https://linear.app/acme/project/auth-redesign-2024",
              teams: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "team-1",
                    key: "BACKEND",
                    name: "Backend Team",
                  },
                  {
                    id: "team-2",
                    key: "SECURITY",
                    name: "Security Team",
                  },
                ],
              },
              labels: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              issues: {
                nodes: [
                  {
                    id: "issue-1",
                    identifier: "AUTH-101",
                    title: "Implement OAuth 2.0 flow",
                    state: {
                      name: "In Progress",
                      type: "started",
                    },
                  },
                  {
                    id: "issue-2",
                    identifier: "AUTH-102",
                    title: "Add MFA support",
                    state: {
                      name: "To Do",
                      type: "unstarted",
                    },
                  },
                  {
                    id: "issue-3",
                    identifier: "AUTH-103",
                    title: "Design new login UI",
                    state: {
                      name: "Done",
                      type: "completed",
                    },
                  },
                  {
                    id: "issue-4",
                    identifier: "AUTH-104",
                    title: "Security audit of current system",
                    state: {
                      name: "Canceled",
                      type: "canceled",
                    },
                  },
                ],
              },
              lastUpdate: {
                id: "update-1",
                body:
                  "Great progress this week! The OAuth implementation is nearly complete and we're on track for our Q1 delivery. The team has been collaborating well across backend and security concerns.\n\n**This week's highlights:**\n- OAuth 2.0 flow implementation 80% complete\n- MFA design reviews completed\n- Security penetration testing scheduled\n\n**Next week:**\n- Complete OAuth testing\n- Begin MFA implementation\n- Finalize UI designs",
                health: "onTrack",
                createdAt: "2024-01-22T16:00:00Z",
                user: {
                  name: "jane.lead",
                  displayName: "Jane Lead",
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

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test with minimal project (no optional fields)
await snapshotTest({
  name: "Project View Command - Minimal Project JSON",
  meta: import.meta,
  colors: false,
  args: ["minimal-project", "--json"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetProjectIdByName",
        variables: { name: "minimal-project" },
        response: {
          data: {
            projects: {
              nodes: [{ id: "minimal-project" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "GetProjectDetails",
        variables: { id: "minimal-project", includeContent: true },
        response: {
          data: {
            organization: { id: "workspace-1", urlKey: "test" },
            project: {
              id: "minimal-project",
              content: null,
              name: "Simple Project",
              description: "",
              slugId: "simple",
              icon: null,
              color: "#64748b",
              status: {
                id: "status-backlog",
                name: "Backlog",
                color: "#94a3b8",
              },
              creator: null,
              lead: null,
              priority: 0,
              health: null,
              startDate: null,
              targetDate: null,
              startedAt: null,
              completedAt: null,
              canceledAt: null,
              updatedAt: "2024-01-20T12:00:00Z",
              createdAt: "2024-01-20T12:00:00Z",
              url: "https://linear.app/acme/project/simple",
              teams: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
              labels: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              issues: {
                nodes: [],
              },
              lastUpdate: null,
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

Deno.test("Project View includes full content by default", async () => {
  const server = new MockLinearServer([
    {
      queryName: "GetProjectIdByName",
      variables: { name: "project-with-content" },
      response: {
        data: {
          projects: {
            nodes: [{ id: "project-with-content" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      queryName: "GetProjectDetails",
      variables: { id: "project-with-content", includeContent: true },
      response: {
        data: {
          organization: { id: "workspace-1", urlKey: "test" },
          project: {
            id: "project-with-content",
            name: "Selling",
            description: "",
            content: "# Project plan\n\nLaunch the new product page.",
            slugId: "selling",
            icon: null,
            color: "#64748b",
            status: { id: "status-started", name: "Started", color: "#22c55e" },
            creator: null,
            lead: null,
            priority: 0,
            health: null,
            startDate: null,
            targetDate: null,
            startedAt: null,
            completedAt: null,
            canceledAt: null,
            updatedAt: "2024-01-20T12:00:00Z",
            createdAt: "2024-01-20T12:00:00Z",
            url: "https://linear.app/acme/project/selling",
            teams: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            labels: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            issues: { nodes: [] },
            lastUpdate: null,
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
    await viewCommand.parse([
      "project-with-content",
      "--json",
    ])
    assertEquals(
      JSON.parse(logs[0]).project.content,
      "# Project plan\n\nLaunch the new product page.",
    )
  } finally {
    logStub.restore()
    await server.stop()
    Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
    Deno.env.delete("LINEAR_API_KEY")
  }
})
