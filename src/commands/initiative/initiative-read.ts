import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { NotFoundError } from "../../utils/errors.ts"

const ReadInitiative = gql(`
  query ReadInitiative($id: String!) {
    organization { id urlKey }
    initiative(id: $id) {
      id slugId name description status targetDate color icon url archivedAt
      owner { id displayName }
    }
  }
`)

export async function readInitiative(
  client: ReturnType<typeof getGraphQLClient>,
  id: string,
) {
  const result = await client.request(ReadInitiative, { id })
  if (!result.initiative) throw new NotFoundError("Initiative", id)
  return result
}
