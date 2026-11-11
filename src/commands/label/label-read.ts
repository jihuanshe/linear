import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import {
  handleNotFound,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"
import { isLinearUuid } from "../../utils/linear.ts"
import { assertReadIdentity } from "../../utils/read-identity.ts"

gql(`
  fragment IssueLabelDetails on IssueLabel {
    id name color description isGroup groupType archivedAt
    parent { id name }
    team { id key name }
  }
`)

const ReadIssueLabel = gql(`
  query ReadIssueLabel($id: String!) {
    organization { id urlKey }
    issueLabel(id: $id) { ...IssueLabelDetails }
  }
`)

export async function readIssueLabel(
  client: ReturnType<typeof getGraphQLClient>,
  id: string,
) {
  if (!isLinearUuid(id)) {
    throw new ValidationError(
      "Label must be a UUID; use 'linear label list --json' to find it",
    )
  }
  const result = await client.request(ReadIssueLabel, { id })
    .catch(handleNotFound("Label", id))
  if (!result.issueLabel) throw new NotFoundError("Label", id)
  assertReadIdentity(
    result.issueLabel,
    id,
    result.organization,
    result.organization.id,
    "Label",
  )
  return result
}

export async function readLabelGroup(
  client: ReturnType<typeof getGraphQLClient>,
  id: string,
) {
  const result = await readIssueLabel(client, id)
  if (!result.issueLabel.isGroup || result.issueLabel.archivedAt != null) {
    throw new ValidationError("Parent must be an active label group")
  }
  return result.issueLabel
}
