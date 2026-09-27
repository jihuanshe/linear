import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { isLinearUuid } from "../../utils/linear.ts"
import { CliError, NotFoundError, ValidationError } from "../../utils/errors.ts"
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

/**
 * `project list --status-name` matches `status.name` exactly, as the project
 * filter does. `firstPage` is the status page read with the first projects.
 */
export async function assertProjectStatusName(
  statusName: string,
  firstPage:
    | { nodes: { name: string }[]; pageInfo: { hasNextPage: boolean } }
    | null
    | undefined,
): Promise<void> {
  if (
    firstPage == null || !Array.isArray(firstPage.nodes) ||
    typeof firstPage.pageInfo?.hasNextPage !== "boolean"
  ) throw new CliError("Linear returned incomplete project statuses")
  const names = firstPage.nodes.map((status) => status.name)
  if (names.includes(statusName)) return
  const all = firstPage.pageInfo.hasNextPage
    ? (await getProjectStatuses()).map((status) => status.name)
    : names
  if (all.includes(statusName)) return
  throw new NotFoundError(
    "Project status",
    `${JSON.stringify(statusName)} (--status-name)`,
    {
      suggestion: `Valid status names (case-sensitive): ${
        all.map((name) => JSON.stringify(name)).join(", ")
      }.`,
      details: { option: "--status-name", values: [statusName] },
    },
  )
}
