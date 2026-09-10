import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { NotFoundError, ValidationError } from "../../utils/errors.ts"
import { isLinearUuid } from "../../utils/linear.ts"

const ReadDocument = gql(`
  query ReadDocument($id: String!) {
    organization { id urlKey }
    document(id: $id) {
      id title content icon url archivedAt
      project { id }
    }
  }
`)

export async function readDocument(
  client: ReturnType<typeof getGraphQLClient>,
  id: string,
) {
  const result = await client.request(ReadDocument, { id })
  if (!result.document) throw new NotFoundError("Document", id)
  if (
    isLinearUuid(id) && result.document.id?.toLowerCase() !== id.toLowerCase()
  ) {
    throw new ValidationError("Document read resolved to a different object")
  }
  return result
}
