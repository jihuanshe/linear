import type { ProjectTeamsQuery } from "../__codegen__/graphql.ts"
import { gql } from "../__codegen__/gql.ts"
import { getGraphQLClient } from "./graphql.ts"
import { CliError, NotFoundError, ValidationError } from "./errors.ts"

const ProjectTeams = gql(`
  query ProjectTeams($id: String!, $after: String) {
    project(id: $id) {
      id
      name
      teams(first: 100, after: $after, includeArchived: true) {
        nodes { id key name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)

export async function getProjectTeams(projectId: string) {
  const client = getGraphQLClient()
  const nodes: Array<{ id: string; key: string; name: string }> = []
  const cursors = new Set<string>()
  let after: string | null = null
  while (true) {
    const result: ProjectTeamsQuery = await client.request(ProjectTeams, {
      id: projectId,
      after,
    })
    const project: ProjectTeamsQuery["project"] = result.project
    if (project == null) throw new NotFoundError("Project", projectId)
    nodes.push(...project.teams.nodes)
    const hasNextPage: boolean = project.teams.pageInfo.hasNextPage
    const endCursor: string | null | undefined =
      project.teams.pageInfo.endCursor
    if (!hasNextPage) {
      return { ...project, teams: { nodes, pageInfo: project.teams.pageInfo } }
    }
    if (!endCursor || cursors.has(endCursor)) {
      throw new CliError(
        "Project teams returned an empty or repeated pagination cursor",
      )
    }
    cursors.add(endCursor)
    after = endCursor
  }
}

/** Share the same complete connection guard with dedicated commands and delivery. */
export function assertProjectTeam(project: unknown, team: string): void {
  const value = project as {
    id?: unknown
    name?: unknown
    teams?: {
      nodes?: Array<{ id?: unknown; key?: unknown }>
      pageInfo?: { hasNextPage?: unknown }
    }
  } | null
  if (
    !value || !Array.isArray(value.teams?.nodes) ||
    value.teams.pageInfo?.hasNextPage !== false
  ) {
    throw new ValidationError(
      "Cannot verify project compatibility: project teams are incomplete",
    )
  }
  const match = value.teams.nodes.some((node) =>
    (typeof node.id === "string" &&
      node.id.toLowerCase() === team.toLowerCase()) ||
    (typeof node.key === "string" &&
      node.key.toLowerCase() === team.toLowerCase())
  )
  if (!match) {
    throw new ValidationError(
      `Team ${team} does not belong to project ${value.name ?? value.id}`,
      {
        suggestion:
          "Choose a project that includes the issue's team, or agree on ownership before explicitly moving the issue or changing project teams. No write was sent.",
      },
    )
  }
}

export async function requireProjectTeam(
  projectId: string,
  team: string,
): Promise<void> {
  assertProjectTeam(await getProjectTeams(projectId), team)
}
