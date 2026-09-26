import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { listCommand } from "../../../src/commands/document/document-list.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

for (
  const scenario of [
    "identifier",
    "UUID",
    "URL",
    "other-workspace",
    "wrong-identity",
    "invalid",
    "empty",
    "missing",
  ] as const
) {
  Deno.test(`document list issue reference: ${scenario}`, async () => {
    const id = "abcdef01-2345-4678-9abc-def012345678"
    const reference = scenario === "UUID" || scenario === "wrong-identity"
      ? id.toUpperCase()
      : scenario === "URL" || scenario === "other-workspace"
      ? "https://linear.app/test/issue/ENG-123/title"
      : scenario === "invalid"
      ? "feature/ENG-123"
      : scenario === "empty"
      ? ""
      : "eng-123"
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "GetIssueReferenceWorkspace",
        response: {
          data: {
            organization: {
              id: "workspace",
              urlKey: scenario === "other-workspace" ? "elsewhere" : "test",
            },
          },
        },
      },
      {
        queryName: "GetIssueId",
        response: {
          data: {
            issue: scenario === "missing" ? null : {
              id: scenario === "wrong-identity"
                ? "11111111-1111-4111-8111-111111111111"
                : id,
            },
          },
        },
      },
      {
        queryName: "ListDocuments",
        response: {
          data: {
            documents: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ])
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "document",
          "list",
          "--issue",
          reference,
          "--json",
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const success = ["identifier", "UUID", "URL"].includes(scenario)
      const body = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(result.code, success ? 0 : 1, JSON.stringify(body))
      assertEquals(
        server.graphqlRequests.filter((request) =>
          request.query.includes("query ListDocuments")
        ).map((request) => request.variables),
        success ? [{ filter: { issue: { id: { eq: id } } }, first: 50 }] : [],
      )
      const lookups = server.graphqlRequests.filter((request) =>
        request.query.includes("query GetIssueId")
      )
      assertEquals(
        lookups.map((request) => request.variables.id),
        ["invalid", "empty", "other-workspace"].includes(scenario) ? [] : [
          scenario === "UUID" || scenario === "wrong-identity" ? id : "ENG-123",
        ],
      )
      if (!success) {
        assertStringIncludes(
          body.error.message,
          scenario === "other-workspace"
            ? "different workspace"
            : scenario === "wrong-identity"
            ? "different stable identity"
            : scenario === "missing"
            ? "not found"
            : "Invalid issue reference",
        )
      }
    } finally {
      await cleanup()
    }
  })
}

Deno.test("document list without --issue does not infer an Issue from VCS", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "ListDocuments",
      response: {
        data: {
          documents: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])
  const Command = Deno.Command
  const commands: ConstructorParameters<typeof Command>[] = []
  const command = stub(Deno, "Command", function (...args: unknown[]) {
    const [executable, options] = args as ConstructorParameters<typeof Command>
    commands.push([executable, options])
    return new Command(executable, options)
  })
  const log = stub(console, "log", () => {})
  try {
    await listCommand.parse(["--json"])
    for (const [executable, options] of commands) {
      assertEquals(executable, "git")
      assertEquals(options?.args, ["rev-parse", "--show-toplevel"])
    }
    assertEquals(server.graphqlRequests.map((request) => request.variables), [{
      first: 50,
    }])
  } finally {
    log.restore()
    command.restore()
    await cleanup()
  }
})

Deno.test("bare document domain exposes command usage without requests", async () => {
  const { server, cleanup } = await setupMockLinearServer([])
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", ...commonDenoArgs, "src/main.ts", "document"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(result.code, 0)
    const output = new TextDecoder().decode(result.stdout)
    assertStringIncludes(output, "linear document — Manage Linear documents")
    assertStringIncludes(output, "list options:")
    assertStringIncludes(output, "update options:")
    assertEquals(
      output.includes("Use --help to see available subcommands"),
      false,
    )
    assertEquals(server.graphqlRequests, [])
  } finally {
    await cleanup()
  }
})

for (const kind of ["UUID", "name", "slug", "unknown"] as const) {
  Deno.test(`document list production entry resolves project ${kind}`, async () => {
    const id = "00000000-0000-0000-0000-000000000000"
    const project = kind === "UUID"
      ? id
      : kind === "slug"
      ? "abc123def456"
      : "Tech Debt"
    const server = new MockLinearServer([
      {
        queryName: "GetProjectIdByName",
        variables: { name: project },
        response: {
          data: {
            projects: {
              nodes: kind === "name" ? [{ id }] : [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "GetProjectIdBySlugId",
        variables: { slugId: project },
        response: {
          data: {
            projects: {
              nodes: kind === "slug" ? [{ id }] : [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "ListDocuments",
        variables: { filter: { project: { id: { eq: id } } }, first: 50 },
        response: {
          data: {
            documents: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
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
          "document",
          "list",
          "--project",
          project,
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
      const stdout = new TextDecoder().decode(result.stdout)
      const stderr = new TextDecoder().decode(result.stderr)
      assertEquals(result.success, kind !== "unknown", stderr)
      assertEquals(
        server.graphqlRequests.map((request) =>
          request.query.match(/(?:query|mutation)\s+(\w+)/)?.[1]
        ),
        kind === "UUID"
          ? ["ListDocuments"]
          : kind === "name"
          ? ["GetProjectIdByName", "ListDocuments"]
          : kind === "slug"
          ? ["GetProjectIdByName", "GetProjectIdBySlugId", "ListDocuments"]
          : ["GetProjectIdByName", "GetProjectIdBySlugId"],
      )
      if (kind === "unknown") {
        const error = JSON.parse(stdout)
        assertEquals(error.ok, false)
        assertEquals(error.effect, "none")
        assertStringIncludes(error.error.message, "not found")
        assertStringIncludes(error.error.message, "Tech Debt")
        assertEquals(stderr, "")
      } else {
        assertEquals(JSON.parse(stdout), {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        })
      }
    } finally {
      await server.stop()
    }
  })
}

// NOTE: Tests for "List All Documents", "Filter By Project", and "Filter By Issue"
// have been removed because they display relative timestamps (e.g., "3 days ago")
// which are inherently non-deterministic. The fakeTime solution causes hangs with
// mock servers (see project-list.test.ts for similar issue).

// Test JSON output (uses raw timestamps, not relative - deterministic)
await snapshotTest({
  name: "Document List Command - JSON Output",
  meta: import.meta,
  colors: false,
  args: ["--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "ListDocuments",
        variables: { first: 50 },
        response: {
          data: {
            documents: {
              nodes: [
                {
                  id: "doc-1",
                  title: "Delegation System Spec",
                  slugId: "d4b93e3b2695",
                  url:
                    "https://linear.app/test/document/delegation-system-spec-d4b93e3b2695",
                  updatedAt: "2026-01-18T10:30:00Z",
                  project: { name: "TinyCloud SDK", slugId: "tinycloud-sdk" },
                  issue: null,
                  creator: { name: "John Doe" },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
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

// Test empty results
await snapshotTest({
  name: "Document List Command - Empty Results",
  meta: import.meta,
  colors: false,
  args: [],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "ListDocuments",
        variables: { first: 50 },
        response: {
          data: {
            documents: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
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

await snapshotTest({
  name: "Document List Command - Filter By Issue JSON Output",
  meta: import.meta,
  colors: false,
  args: ["--issue", "eng-123", "--json"],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueId",
        variables: { id: "ENG-123" },
        response: {
          data: { issue: { id: "issue-uuid" } },
        },
      },
      {
        queryName: "ListDocuments",
        variables: {
          filter: { issue: { id: { eq: "issue-uuid" } } },
          first: 50,
        },
        response: {
          data: {
            documents: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
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

await snapshotTest({
  name: "Document List Command - Rejects Invalid Limit",
  meta: import.meta,
  colors: false,
  args: ["--limit", "0"],
  denoArgs: commonDenoArgs,
  canFail: true,
  async fn() {
    await listCommand.parse()
  },
})
