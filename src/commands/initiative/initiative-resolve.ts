import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { NotFoundError, ValidationError } from "../../utils/errors.ts"

const FindInitiative = gql(`
  query FindInitiative($filter: InitiativeFilter!, $includeArchived: Boolean!) {
    initiatives(first: 2, filter: $filter, includeArchived: $includeArchived) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

/** Resolve once; neither ambiguous matches nor failed reads may choose a target. */
export async function resolveInitiativeId(
  client: ReturnType<typeof getGraphQLClient>,
  value: string,
  includeArchived = false,
): Promise<string> {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    return value.toLowerCase()
  }
  for (
    const filter of [{ slugId: { eq: value } }, {
      name: { eqIgnoreCase: value },
    }]
  ) {
    const { initiatives } = await client.request(FindInitiative, {
      filter,
      includeArchived,
    })
    if (initiatives.nodes.length > 1 || initiatives.pageInfo.hasNextPage) {
      throw new ValidationError(`Initiative reference is ambiguous: ${value}`, {
        suggestion: "Use the initiative UUID.",
      })
    }
    if (initiatives.nodes.length === 1) return initiatives.nodes[0].id
  }
  throw new NotFoundError("Initiative", value)
}
