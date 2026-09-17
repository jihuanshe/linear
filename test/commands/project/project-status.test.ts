import { assertEquals, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { Select } from "@cliffy/prompt"
import { createCommand } from "../../../src/commands/project/project-create.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const projectId = "550e8400-e29b-41d4-a716-446655440100"
const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const pageInfo = { hasNextPage: false, endCursor: null }

for (const operation of ["create", "update"]) {
  for (
    const scenario of [
      "second-page",
      "ambiguous",
      "missing",
      "read-failure",
      "UUID",
      "omitted",
    ]
  ) {
    Deno.test(`project ${operation} status: ${scenario}`, async () => {
      const { server, cleanup } = await setupMockLinearServer([
        {
          queryName: "GetWriteTeamByKey",
          response: {
            data: { teams: { nodes: [{ id: "team", key: "ENG" }], pageInfo } },
          },
        },
        {
          queryName: "GetProjectStatuses",
          response: ({ variables }) =>
            variables.after == null
              ? {
                data: {
                  projectStatuses: {
                    nodes: [{
                      id: firstId,
                      name: "First",
                      type: scenario === "ambiguous" ? "started" : "planned",
                    }],
                    pageInfo: { hasNextPage: true, endCursor: "next" },
                  },
                },
              }
              : scenario === "read-failure"
              ? { errors: [{ message: "Status page unavailable" }] }
              : {
                data: {
                  projectStatuses: {
                    nodes: [{
                      id: secondId,
                      name: "Second",
                      type: scenario === "missing" ? "completed" : "started",
                    }],
                    pageInfo,
                  },
                },
              },
        },
        {
          queryName: "ReadProject",
          response: {
            data: {
              organization: { id: "workspace", urlKey: "test" },
              project: {
                id: projectId,
                name: "Original",
                status: { id: "original-status" },
                teams: { nodes: [], pageInfo },
                labels: { nodes: [], pageInfo },
              },
            },
          },
        },
        {
          queryName: operation === "create" ? "CreateProject" : "UpdateProject",
          response: {
            data: {
              [operation === "create" ? "projectCreate" : "projectUpdate"]: {
                success: true,
                project: {
                  id: projectId,
                  name: "New",
                  slugId: "new",
                  url: "https://linear.app/test/project/new",
                },
              },
            },
          },
        },
      ])
      try {
        const args = operation === "create"
          ? ["--name", "New", "--team", "ENG"]
          : [projectId, "--unprotected", "--name", "New"]
        if (scenario !== "omitted") {
          args.push(
            "--status",
            scenario === "UUID" ? secondId.toUpperCase() : "started",
          )
        }
        const result = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            ...commonDenoArgs,
            "src/main.ts",
            "project",
            operation,
            ...args,
            "--json",
          ],
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output()
        const body = JSON.parse(new TextDecoder().decode(result.stdout))
        const success = ["second-page", "UUID", "omitted"].includes(scenario)
        assertEquals(result.code, success ? 0 : 1, JSON.stringify(body))
        const writes = server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        )
        assertEquals(writes.length, success ? 1 : 0)
        if (success) {
          assertEquals(body.effect, "applied")
          assertEquals(
            (writes[0].variables.input as Record<string, unknown>).statusId,
            scenario === "omitted" ? undefined : secondId,
          )
        } else {
          assertEquals(body.effect, "none")
          assertStringIncludes(
            body.error.message,
            scenario === "ambiguous"
              ? "ambiguous"
              : scenario === "missing"
              ? "not found"
              : "Status page unavailable",
          )
        }
        assertEquals(
          server.graphqlRequests.filter((request) =>
            request.query.includes("query GetProjectStatuses")
          ).map((request) => request.variables),
          ["UUID", "omitted"].includes(scenario) ? [] : [{}, { after: "next" }],
        )
      } finally {
        await cleanup()
      }
    })
  }
}

Deno.test("interactive project status uses the selected UUID across pages with duplicate types", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetWriteTeamByKey",
      response: {
        data: { teams: { nodes: [{ id: "team", key: "ENG" }], pageInfo } },
      },
    },
    {
      queryName: "GetProjectStatuses",
      response: ({ variables }) => ({
        data: {
          projectStatuses: {
            nodes: [{
              id: variables.after == null ? firstId : secondId,
              name: variables.after == null ? "First" : "Second",
              type: "planned",
            }],
            pageInfo: variables.after == null
              ? { hasNextPage: true, endCursor: "next" }
              : pageInfo,
          },
        },
      }),
    },
    {
      queryName: "LookupUserById",
      response: { data: { users: { nodes: [{ id: firstId }], pageInfo } } },
    },
    {
      queryName: "CreateProject",
      response: {
        data: {
          projectCreate: {
            success: true,
            project: {
              id: projectId,
              name: "New",
              slugId: "new",
              url: "https://linear.app/test/project/new",
            },
          },
        },
      },
    },
  ])
  const stdin = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const stdout = stub(
    Object.getPrototypeOf(Deno.stdout),
    "isTerminal",
    () => true,
  )
  const select = stub(
    Select,
    "prompt",
    (options: { message: string; options: unknown }) => {
      assertEquals(options.message, "Status:")
      assertEquals(options.options, [{ name: "First", value: firstId }, {
        name: "Second",
        value: secondId,
      }])
      return Promise.resolve(secondId)
    },
  )
  const log = stub(console, "log", () => {})
  try {
    await createCommand.parse([
      "--interactive",
      "--name",
      "New",
      "--description",
      "Description",
      "--team",
      "ENG",
      "--lead",
      firstId,
      "--start-date",
      "2026-01-01",
      "--target-date",
      "2026-12-31",
    ])
    assertEquals(select.calls.length, 1)
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("query GetProjectStatuses")
      ).length,
      2,
    )
    const writes = server.graphqlRequests.filter((request) =>
      request.query.includes("mutation CreateProject")
    )
    assertEquals(writes.length, 1)
    assertEquals(
      (writes[0].variables.input as Record<string, unknown>).statusId,
      secondId,
    )
  } finally {
    log.restore()
    select.restore()
    stdout.restore()
    stdin.restore()
    await cleanup()
  }
})
