import { gql } from "../__codegen__/gql.ts"
import { getGraphQLClient } from "./graphql.ts"
import { completeConnection } from "./pagination.ts"
import { NotFoundError, ValidationError } from "./errors.ts"
import { isLinearUuid } from "./linear.ts"
import type { IssueFieldsFragment } from "../__codegen__/graphql.ts"

// View and replacement reads use exactly the same API field projection.
// It is a GraphQL fragment, not a second hand-written response model.
export const issueScalarFieldsFragment = gql(`
  fragment IssueScalarFields on Issue {
    id identifier archivedAt trashed title description url branchName
    priority estimate dueDate
    state { id name type color }
    assignee { id name displayName }
    project { id name slugId }
    projectMilestone { id name }
    cycle { id number name isActive isNext isPrevious isFuture isPast }
    team { id key activeCycle { number } }
    parent { id identifier title state { name color } }
  }
`)
export const issueFieldsFragment = gql(`
  fragment IssueFields on Issue {
    ...IssueScalarFields
    labels(first: 250) {
      nodes { id name color }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

const IssueForWrite = gql(`
  query GetIssueForWrite($id: String!) {
    organization { id urlKey }
    issue(id: $id) { ...IssueFields }
  }
`)

const IssueLabels = gql(`
  query GetIssueLabelsForWrite($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      labels(first: $first, after: $after) {
        nodes { id name color }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)

const IssueScalars = gql(`
  query GetIssueWriteScalars($id: String!) {
    organization { id urlKey }
    issue(id: $id) { ...IssueScalarFields }
  }
`)

export async function completeIssueLabels(
  issueId: string,
  initial: IssueFieldsFragment["labels"],
  signal?: AbortSignal,
) {
  return await completeConnection(initial, async (after, first) => {
    const result = await getGraphQLClient().request({
      document: IssueLabels,
      variables: { id: issueId, first, after },
      signal,
    })
    if (result.issue == null) throw new NotFoundError("Issue", issueId)
    return result.issue.labels
  }, `labels for ${issueId}`)
}

export async function readIssueBasis(issueId: string, signal?: AbortSignal) {
  const result = await getGraphQLClient().request({
    document: IssueForWrite,
    variables: { id: issueId },
    signal,
  })
  if (result.issue == null) throw new NotFoundError("Issue", issueId)
  if (
    isLinearUuid(issueId) &&
    result.issue.id?.toLowerCase() !== issueId.toLowerCase()
  ) {
    throw new ValidationError(
      "Issue read resolved to a different stable identity",
    )
  }
  const labels = await completeIssueLabels(
    result.issue.id,
    result.issue.labels,
    signal,
  )
  if (result.issue.labels.pageInfo.hasNextPage) {
    // Paging a large label set must not leave scalar comparisons at the start
    // of that potentially slow read. The collection still is not atomic.
    const latest = await getGraphQLClient().request({
      document: IssueScalars,
      variables: { id: result.issue.id },
      signal,
    })
    if (
      latest.issue?.id !== result.issue.id ||
      latest.organization?.id !== result.organization.id
    ) {
      throw new ValidationError(
        "Issue or workspace changed while completing the read",
      )
    }
    return { ...latest, issue: { ...latest.issue, labels } }
  }
  return { ...result, issue: { ...result.issue, labels } }
}

const IssueHeader = gql(`
  query GetIssueHeader($id: String!) {
    issue(id: $id) { id identifier title url }
  }
`)

/** Small terminal projections do not need comments, attachments or details. */
export async function readIssueHeader(issueId: string) {
  const data = await getGraphQLClient().request(IssueHeader, { id: issueId })
  if (data.issue == null) throw new NotFoundError("Issue", issueId)
  if (
    typeof data.issue.id !== "string" || !data.issue.id ||
    typeof data.issue.identifier !== "string" || !data.issue.identifier
  ) {
    throw new ValidationError("Issue header returned no stable identity")
  }
  if (
    isLinearUuid(issueId) &&
    data.issue.id.toLowerCase() !== issueId.toLowerCase()
  ) {
    throw new ValidationError(
      "Issue header resolved to a different stable identity",
    )
  }
  return data.issue
}

const TeamById = gql(`
  query GetWriteTeamById($id: String!) {
    team(id: $id) { id key }
  }
`)
const TeamByKey = gql(`
  query GetWriteTeamByKey($key: String!) {
    teams(first: 2, filter: { key: { eqIgnoreCase: $key } }) {
      nodes { id key }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

/** Resolve once; subsequent operations use the returned UUID, not the key. */
export async function resolveWriteTeam(input: string) {
  const client = getGraphQLClient()
  if (isLinearUuid(input)) {
    const result = await client.request(TeamById, { id: input })
    if (result.team == null) throw new NotFoundError("Team", input)
    return result.team
  }
  const result = await client.request(TeamByKey, { key: input })
  if (result.teams.nodes.length === 0) throw new NotFoundError("Team", input)
  if (result.teams.nodes.length !== 1 || result.teams.pageInfo.hasNextPage) {
    throw new ValidationError(`Team is ambiguous: ${input}`)
  }
  return result.teams.nodes[0]
}
