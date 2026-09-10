import { setupMockLinearServer } from "./test-helpers.ts"
import type { MockLinearServer } from "./mock_linear_server.ts"

type MockResponses = NonNullable<
  ConstructorParameters<typeof MockLinearServer>[0]
>

export const issueWriteId = "11111111-1111-4111-8111-111111111111"
export const teamWriteIds: Record<string, string> = {
  ENG: "22222222-2222-4222-8222-222222222222",
  OPS: "33333333-3333-4333-8333-333333333333",
  NEW: "77777777-7777-4777-8777-777777777777",
  OLD: "88888888-8888-4888-8888-888888888888",
  PLA4: "99999999-9999-4999-8999-999999999999",
}
export const terminalPage = { hasNextPage: false, endCursor: null }

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Fixed pre-write values for the existing resolver/option regression tests. */
export function issueWriteBasis(
  identifier = "ENG-123",
  team = { id: teamWriteIds.ENG, key: "ENG" },
) {
  return {
    organization: { id: "workspace-id", urlKey: "test-team" },
    issue: {
      id: issueWriteId,
      identifier,
      title: "Before title",
      description: "Before description" as string | null,
      priority: 4,
      estimate: 13,
      dueDate: null,
      archivedAt: null,
      trashed: false,
      url: `https://linear.app/test-team/issue/${identifier}`,
      team,
      state: { id: "state-before", name: "Todo", type: "unstarted" },
      assignee: { id: "user-before", name: "Before" },
      project: null as { id: string } | null,
      projectMilestone: null,
      cycle: { id: "cycle-before" },
      parent: null,
      labels: {
        nodes: [{ id: "label-before", name: "Before" }],
        pageInfo: terminalPage,
      },
    },
  }
}

/**
 * Keep the existing narrow lookup fixtures while supplying the full current
 * read required by dedicated writes. Guard scenarios use explicit stateful
 * responses instead of this fixed baseline.
 */
export async function setupIssueWriteServer(
  responses: MockResponses = [],
  envVars?: Record<string, string>,
) {
  const fixtures: MockResponses = responses.map((response) => {
    const field = response.queryName.startsWith("GetProjectIdBy")
      ? "projects"
      : response.queryName === "GetIssueLabelIdByNameForTeam"
      ? "issueLabels"
      : ["LookupUser", "LookupUserById"].includes(response.queryName)
      ? "users"
      : undefined
    if (field == null) return response
    if (typeof response.response === "function") return response
    const data = object(response.response.data)
    const connection = object(data[field])
    if (!Array.isArray(connection.nodes)) return response
    return {
      ...response,
      response: {
        ...response.response,
        data: {
          ...data,
          [field]: {
            ...connection,
            pageInfo: connection.pageInfo ?? terminalPage,
          },
        },
      },
    }
  })

  for (const response of responses) {
    if (response.queryName !== "GetTeamIdByKey") continue
    const key = String(
      response.variables?.team ?? envVars?.LINEAR_TEAM_ID ?? "ENG",
    )
    fixtures.push({
      queryName: "GetWriteTeamByKey",
      variables: { key },
      response: async (request, history) => {
        const original = typeof response.response === "function"
          ? await response.response(request, history)
          : response.response
        const data = object(original.data)
        const teams = object(data.teams)
        if (!Array.isArray(teams.nodes)) return original
        return {
          ...original,
          data: {
            ...data,
            teams: {
              ...teams,
              nodes: teams.nodes.map((team) => ({
                ...object(team),
                key: object(team).key ?? key,
              })),
              pageInfo: teams.pageInfo ?? terminalPage,
            },
          },
        }
      },
    })
  }

  if (
    !responses.some((response) => response.queryName === "GetIssueForWrite")
  ) {
    let identifier = "ENG-123"
    fixtures.push({
      queryName: "GetIssueForWrite",
      response: (request) => {
        const reference = String(request.variables.id)
        if (/^[A-Z][A-Z0-9]*-\d+$/.test(reference)) identifier = reference
        const key = identifier.slice(0, identifier.lastIndexOf("-"))
        const originalTeam = responses.find((response) =>
          response.queryName === "GetIssueTeam"
        )
        const oldTeam = typeof originalTeam?.response === "object"
          ? object(object(originalTeam.response.data).issue).team
          : undefined
        const basis = issueWriteBasis(identifier, {
          id: String(object(oldTeam).id ?? teamWriteIds[key]),
          key: String(object(oldTeam).key ?? key),
        })
        const originalProject = responses.find((response) =>
          response.queryName === "GetIssueProjectId"
        )
        if (typeof originalProject?.response === "object") {
          const project =
            object(object(originalProject.response.data).issue).project
          if (project === null || typeof object(project).id === "string") {
            basis.issue.project = project as { id: string } | null
          }
        }
        return { data: basis }
      },
    })
  }
  return await setupMockLinearServer(fixtures, envVars)
}
