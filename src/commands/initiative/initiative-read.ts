import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { NotFoundError, ValidationError } from "../../utils/errors.ts"

const ReadInitiative = gql(`
  query ReadInitiative($id: ID!) {
    organization { id urlKey }
    initiatives(first: 2, filter: { id: { eq: $id } }, includeArchived: true) {
      nodes {
        id slugId name description status targetDate health color icon url archivedAt
        createdAt updatedAt trashed
        owner { id name displayName }
        projects {
          nodes { id slugId name status { name type } }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

export async function readInitiative(
  client: ReturnType<typeof getGraphQLClient>,
  id: string,
) {
  const result = await client.request(ReadInitiative, { id })
  const { nodes, pageInfo } = result.initiatives
  if (nodes.length > 1 || pageInfo.hasNextPage) {
    throw new ValidationError(`Initiative reference is ambiguous: ${id}`)
  }
  const initiative = nodes[0]
  if (!initiative || initiative.id !== id) {
    throw new NotFoundError("Initiative", id)
  }
  return { organization: result.organization, initiative }
}
