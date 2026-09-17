import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { isLinearUuid } from "../../utils/linear.ts"
import { NotFoundError, ValidationError } from "../../utils/errors.ts"
import { completeConnection } from "../../utils/pagination.ts"

const GetProjectStatuses = gql(`
  query GetProjectStatuses($after: String) {
    projectStatuses(first: 100, after: $after) {
      nodes { id name type }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

export async function getProjectStatuses() {
  const client = getGraphQLClient()
  const result = await client.request(GetProjectStatuses, {})
  return (await completeConnection(
    result.projectStatuses,
    async (after) =>
      (await client.request(GetProjectStatuses, { after })).projectStatuses,
    "project statuses",
  )).nodes
}

export async function resolveProjectStatusId(value: string): Promise<string> {
  if (isLinearUuid(value)) return value.toLowerCase()
  const type = value.toLowerCase()
  if (
    !["planned", "started", "paused", "completed", "canceled", "backlog"]
      .includes(type)
  ) {
    throw new ValidationError(`Invalid status: ${value}`, {
      suggestion:
        "Use a status UUID or type: planned, started, paused, completed, canceled, backlog",
    })
  }
  const matches = (await getProjectStatuses()).filter((status) =>
    status.type === type
  )
  if (matches.length > 1) {
    throw new ValidationError(`Project status type is ambiguous: ${type}`, {
      suggestion: "Use the exact Project status UUID with --status.",
    })
  }
  if (matches.length === 0) throw new NotFoundError("Project status", type)
  return matches[0].id
}
