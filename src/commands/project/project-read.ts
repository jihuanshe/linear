import { gql } from "../../__codegen__/gql.ts"
import type { ReadProjectQuery } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { NotFoundError } from "../../utils/errors.ts"
import { completeConnection } from "../../utils/pagination.ts"

const ReadProject = gql(`
  query ReadProject($id: String!, $teamsAfter: String, $labelsAfter: String) {
    organization { id urlKey }
    project(id: $id) {
      ...ProjectReplacementFields
      teams(first: 100, after: $teamsAfter) {
        nodes { id key name }
        pageInfo { hasNextPage endCursor }
      }
      labels(first: 100, after: $labelsAfter) {
        nodes { id name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
  fragment ProjectReplacementFields on Project {
    id name description startDate targetDate url archivedAt
    status { id }
    lead { id }
  }
`)

const ReadProjectFields = gql(`
  query ReadProjectFields($id: String!) {
    organization { id urlKey }
    project(id: $id) { ...ProjectReplacementFields }
  }
`)

const ReadProjectTeams = gql(`
  query ReadProjectTeams($id: String!, $after: String!) {
    project(id: $id) {
      id
      teams(first: 100, after: $after) {
        nodes { id key name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)

const ReadProjectLabels = gql(`
  query ReadProjectLabels($id: String!, $after: String!) {
    project(id: $id) {
      id
      labels(first: 100, after: $after) {
        nodes { id name }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)

export async function readProject(
  client: ReturnType<typeof getGraphQLClient>,
  id: string,
) {
  const result = await client.request(ReadProject, { id })
  if (!result.project) throw new NotFoundError("Project", id)
  const paginated = result.project.teams.pageInfo?.hasNextPage === true ||
    result.project.labels.pageInfo?.hasNextPage === true
  await completeProjectCollections(client, result.project)
  if (paginated) {
    // Finish potentially long collection reads before observing scalar fields
    // for the final replacement decision. The pages are not an atomic snapshot.
    const latest = await client.request(ReadProjectFields, {
      id: result.project.id,
    })
    if (!latest.project || latest.project.id !== result.project.id) {
      throw new NotFoundError("Project", id)
    }
    result.organization = latest.organization
    const { teams, labels } = result.project
    Object.assign(result.project, latest.project, { teams, labels })
  }
  return result
}

export async function completeProjectCollections(
  client: ReturnType<typeof getGraphQLClient>,
  project: Pick<
    NonNullable<ReadProjectQuery["project"]>,
    "id" | "teams" | "labels"
  >,
) {
  project.teams = await completeConnection(
    project.teams,
    async (after) => {
      const next = await client.request(ReadProjectTeams, {
        id: project.id,
        after,
      })
      if (
        !next.project || next.project.id !== project.id
      ) throw new NotFoundError("Project", project.id)
      return next.project.teams
    },
    "project teams",
  )
  project.labels = await completeConnection(
    project.labels,
    async (after) => {
      const next = await client.request(ReadProjectLabels, {
        id: project.id,
        after,
      })
      if (
        !next.project || next.project.id !== project.id
      ) throw new NotFoundError("Project", project.id)
      return next.project.labels
    },
    "project labels",
  )
}
