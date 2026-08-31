import { gql } from "../__codegen__/gql.ts"
import type {
  GetProjectsForDoctorQuery,
  ProjectFilter,
} from "../__codegen__/graphql.ts"
import { NotFoundError } from "../utils/errors.ts"
import { getGraphQLClient } from "../utils/graphql.ts"
import { lookupUserId } from "../utils/linear.ts"
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
  assignee?: "self"
  includeArchived?: boolean
}

export async function fetchProjectsForDoctor(
  options: FetchDoctorProjectsOptions = {},
): Promise<DoctorProject[]> {
  const filter: ProjectFilter = {}
  if (options.teamKey != null) {
    filter.accessibleTeams = { some: { key: { eq: options.teamKey } } }
  } else if (options.projectId != null) {
    filter.id = { eq: options.projectId }
  }
  if (options.assignee != null) {
    const assigneeId = await lookupUserId(options.assignee)
    if (assigneeId == null) throw new NotFoundError("User", options.assignee)
    filter.issues = { some: { assignee: { id: { eq: assigneeId } } } }
  }

  const projects: DoctorProject[] = []
  let hasNextPage = true
  let after: string | null | undefined = undefined

  while (hasNextPage) {
    const result: GetProjectsForDoctorQuery = await getGraphQLClient().request(
      GetProjectsForDoctor,
      {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
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
