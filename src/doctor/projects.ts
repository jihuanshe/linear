import { gql } from "../__codegen__/gql.ts"
import type { GetProjectsForDoctorQuery } from "../__codegen__/graphql.ts"
import { getGraphQLClient } from "../utils/graphql.ts"
import type { DoctorProject } from "./types.ts"

const GetProjectsForDoctor = gql(`
  query GetProjectsForDoctor(
    $filter: ProjectFilter
    $first: Int
    $after: String
    $includeArchived: Boolean
  ) {
    projects(
      filter: $filter
      first: $first
      after: $after
      includeArchived: $includeArchived
    ) {
      nodes {
        id
        name
        createdAt
        startedAt
        status {
          name
          type
        }
        health
        healthUpdatedAt
        lastUpdate {
          createdAt
          updatedAt
          health
          isStale
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`)

export interface FetchDoctorProjectsOptions {
  teamKey?: string
  projectId?: string
  includeArchived?: boolean
}

export async function fetchProjectsForDoctor(
  options: FetchDoctorProjectsOptions = {},
): Promise<DoctorProject[]> {
  const filter = options.teamKey != null
    ? { accessibleTeams: { some: { key: { eq: options.teamKey } } } }
    : options.projectId != null
    ? { id: { eq: options.projectId } }
    : undefined

  const projects: DoctorProject[] = []
  let hasNextPage = true
  let after: string | null | undefined = undefined

  while (hasNextPage) {
    const result: GetProjectsForDoctorQuery = await getGraphQLClient().request(
      GetProjectsForDoctor,
      {
        filter,
        first: 100,
        after,
        includeArchived: options.includeArchived,
      },
    )
    projects.push(...result.projects.nodes)
    hasNextPage = result.projects.pageInfo.hasNextPage
    after = result.projects.pageInfo.endCursor
  }

  return projects
}
