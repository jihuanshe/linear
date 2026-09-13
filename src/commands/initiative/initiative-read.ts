import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { NotFoundError, ValidationError } from "../../utils/errors.ts"

const ReadInitiative = gql(`
  query ReadInitiative($id: ID!, $includeContent: Boolean!) {
    organization { id urlKey }
    initiatives(first: 2, filter: { id: { eq: $id } }, includeArchived: true) {
      nodes {
        id slugId name description content @include(if: $includeContent) status targetDate health color icon url archivedAt
        createdAt updatedAt trashed
        owner { id name displayName }
        projects {
          nodes { id slugId name description url status { name type } }
          pageInfo { hasNextPage endCursor }
        }
        documents(first: 50, includeArchived: false) @include(if: $includeContent) {
          nodes { id slugId title url }
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
  options: { includeContent?: boolean } = {},
) {
  const result = await client.request(ReadInitiative, {
    id,
    includeContent: options.includeContent === true,
  })
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
