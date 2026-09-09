import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { NotFoundError, ValidationError } from "../../utils/errors.ts"
import { isLinearUuid } from "../../utils/linear.ts"

const ReadMilestone = gql(`
  query ReadMilestone($id: String!) {
    organization { id urlKey }
    projectMilestone(id: $id) {
      id name description targetDate sortOrder archivedAt
      project { id name }
    }
  }
`)

export async function readMilestone(
  client: ReturnType<typeof getGraphQLClient>,
  id: string,
) {
  const result = await client.request(ReadMilestone, { id })
  if (!result.projectMilestone) throw new NotFoundError("Milestone", id)
  if (
    isLinearUuid(id) &&
    result.projectMilestone.id?.toLowerCase() !== id.toLowerCase()
  ) {
    throw new ValidationError("Milestone read resolved to a different object")
  }
  return result
}
