import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { createCommand } from "../../../src/commands/issue/issue-create.ts"
import { updateCommand } from "../../../src/commands/issue/issue-update.ts"
import { teamsCommand } from "../../../src/commands/project/project-teams.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

const projectId = "abcdef01-2345-4678-9abc-def012345678"
const eligibleTeam = { id: "team-eng-id", key: "ENG", name: "Engineering" }

for (const operation of ["create", "update", "move"] as const) {
  for (
    const scenario of [
      "eligible",
      "incompatible",
      "read-failure",
      "broken-cursor",
    ] as const
  ) {
    Deno.test(`project preflight ${operation}: ${scenario}`, async () => {
      const { server, cleanup } = await setupMockLinearServer([
        {
          queryName: "GetTeamIdByKey",
          response: { data: { teams: { nodes: [eligibleTeam] } } },
        },
        {
          queryName: "GetViewerId",
          response: { data: { viewer: { id: "viewer-id" } } },
        },
        {
          queryName: "GetIssueProjectId",
          response: { data: { issue: { project: { id: projectId } } } },
        },
        {
          queryName: "ProjectTeams",
          response: scenario === "read-failure"
            ? { errors: [{ message: "Project unavailable" }] }
            : {
              data: {
                project: {
                  id: projectId,
                  name: "Release",
                  teams: {
                    nodes: scenario === "eligible" ? [eligibleTeam] : [],
                    pageInfo: {
                      hasNextPage: scenario === "broken-cursor",
                      endCursor: null,
                    },
                  },
                },
              },
            },
        },
        {
          queryName: operation === "create" ? "CreateIssue" : "UpdateIssue",
          response: {
            data: {
              [operation === "create" ? "issueCreate" : "issueUpdate"]: {
                success: true,
                issue: {
                  id: "issue-id",
                  identifier: "ENG-123",
                  title: "Title",
                  url: "https://linear.app/test/issue/ENG-123",
                  team: { key: "ENG" },
                },
              },
            },
          },
        },
      ], { LINEAR_PROMPT_DISABLED: "1" })
      const errors: string[] = []
      const logs = stub(console, "log", () => {})
      const stderr = stub(
        console,
        "error",
        (...args: unknown[]) => errors.push(args.join(" ")),
      )
      const exit = stub(Deno, "exit", () => {
        throw new Error("EXIT")
      })
      try {
        const args = operation === "create"
          ? [
            "--title",
            "Title",
            "--team",
            "ENG",
            "--project",
            projectId,
            "--json",
          ]
          : operation === "move"
          ? ["OPS-123", "--team", "ENG", "--json"]
          : ["ENG-123", "--project", projectId, "--json"]
        const run = () =>
          operation === "create"
            ? createCommand.parse(args)
            : updateCommand.parse(args)
        if (scenario === "eligible") await run()
        else {
          await assertRejects(run, Error, "EXIT")
          assertStringIncludes(
            errors.join("\n"),
            scenario === "incompatible"
              ? "Team ENG does not belong"
              : scenario === "read-failure"
              ? "Project unavailable"
              : "pagination: empty or repeated cursor",
          )
        }
        const mutations = server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        )
        assertEquals(mutations.length, scenario === "eligible" ? 1 : 0)
        assertEquals(
          server.graphqlRequests.some((request) =>
            request.query.includes("ProjectTeams")
          ),
          true,
        )
      } finally {
        logs.restore()
        stderr.restore()
        exit.restore()
        await cleanup()
      }
    })
  }
}

Deno.test("project teams command reads every page and preserves the connection", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "ProjectTeams",
      variables: { id: projectId, after: null },
      response: {
        data: {
          project: {
            id: projectId,
            name: "Release",
            teams: {
              nodes: [{ id: "ops", key: "OPS", name: "Operations" }],
              pageInfo: { hasNextPage: true, endCursor: "next" },
            },
          },
        },
      },
    },
    {
      queryName: "ProjectTeams",
      variables: { id: projectId, after: "next" },
      response: {
        data: {
          project: {
            id: projectId,
            name: "Release",
            teams: {
              nodes: [eligibleTeam],
              pageInfo: { hasNextPage: false, endCursor: "end" },
            },
          },
        },
      },
    },
  ])
  const logs: string[] = []
  const output = stub(console, "log", (value: string) => logs.push(value))
  try {
    await teamsCommand.parse([projectId, "--json"])
    const result = JSON.parse(logs.join(""))
    assertEquals(result.teams.nodes.map((team: { key: string }) => team.key), [
      "OPS",
      "ENG",
    ])
    assertEquals(result.teams.pageInfo, {
      hasNextPage: false,
      endCursor: "end",
    })
    assertEquals(server.graphqlRequests.length, 2)
  } finally {
    output.restore()
    await cleanup()
  }
})
