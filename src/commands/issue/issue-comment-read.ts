import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { NotFoundError, ValidationError } from "../../utils/errors.ts"
import { isLinearUuid } from "../../utils/linear.ts"

const ReadComment = gql(`
  query ReadComment($id: String!) {
    organization { id urlKey }
    comment(id: $id) {
      id body url updatedAt archivedAt
      user { id name displayName }
      issue { id identifier }
    }
  }
`)

export async function readComment(
  client: ReturnType<typeof getGraphQLClient>,
  id: string,
) {
  const result = await client.request(ReadComment, { id })
  if (!result.comment) throw new NotFoundError("Comment", id)
  if (
    isLinearUuid(id) && result.comment.id?.toLowerCase() !== id.toLowerCase()
  ) {
    throw new ValidationError("Comment read resolved to a different object")
  }
  return result
}
