import { Command } from "@cliffy/command"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getIssueIdentifier } from "../../utils/linear.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

const issueHistoryQuery = gql(`
  query GetIssueHistory($id: String!, $after: String) {
    issue(id: $id) {
      identifier
      history(first: 100, after: $after, orderBy: createdAt) {
        nodes {
          createdAt
          actor { name displayName }
          botActor { name type subType userDisplayName }
          fromProject { name }
          toProject { name }
          fromAssignee { name displayName }
          toAssignee { name displayName }
          fromState { name }
          toState { name }
          changes
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)

export const historyCommand = new Command()
  .name("history")
  .description("Show issue history (project, assignee and state changes)")
  .arguments("[issueId:string]")
  .option("-j, --json", "Output history as JSON")
  .action(async ({ json }, issueId) => {
    try {
      const resolvedIdentifier = await getIssueIdentifier(issueId)
      if (!resolvedIdentifier) {
        throw new ValidationError(
          "Could not determine issue identifier",
          { suggestion: "Please provide an issue identifier like 'ENG-123'." },
        )
      }

      const client = getGraphQLClient()
      const nodes = []
      let after: string | null | undefined
      let pageInfo = { hasNextPage: false, endCursor: null as string | null }
      while (true) {
        const data = await client.request(issueHistoryQuery, {
          id: resolvedIdentifier,
          after,
        })
        const page = data.issue?.history
        if (!page) {
          throw new ValidationError(
            `Could not read history for ${resolvedIdentifier}`,
          )
        }
        nodes.push(...page.nodes)
        pageInfo = page.pageInfo
        if (!pageInfo.hasNextPage) break
        if (pageInfo.endCursor == null || pageInfo.endCursor === after) {
          throw new ValidationError(
            `Incomplete history pagination for ${resolvedIdentifier}`,
          )
        }
        after = pageInfo.endCursor
      }
      const history = {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      }

      if (json) {
        console.log(JSON.stringify(history, null, 2))
        return
      }

      if (history.nodes.length === 0) {
        console.log(`No history found for ${resolvedIdentifier}`)
        return
      }

      for (const entry of history.nodes) {
        const actor = entry.actor?.displayName || entry.actor?.name ||
          entry.botActor?.name || entry.botActor?.userDisplayName ||
          (entry.botActor?.type ? `bot:${entry.botActor.type}` : "system")
        const changes: string[] = []
        if (entry.fromProject || entry.toProject) {
          changes.push(
            `project: ${entry.fromProject?.name ?? "-"} -> ${
              entry.toProject?.name ?? "-"
            }`,
          )
        }
        if (entry.fromAssignee || entry.toAssignee) {
          const from = entry.fromAssignee?.displayName ||
            entry.fromAssignee?.name || "-"
          const to = entry.toAssignee?.displayName || entry.toAssignee?.name ||
            "-"
          changes.push(`assignee: ${from} -> ${to}`)
        }
        if (entry.fromState || entry.toState) {
          changes.push(
            `state: ${entry.fromState?.name ?? "-"} -> ${
              entry.toState?.name ?? "-"
            }`,
          )
        }
        if (entry.changes) {
          changes.push(`changes: ${JSON.stringify(entry.changes)}`)
        }
        console.log(
          `${entry.createdAt} ${actor}: ${
            changes.join("; ") || "metadata changed"
          }`,
        )
      }
      if (history.pageInfo.hasNextPage) {
        console.error(
          "Warning: history is truncated at 100 entries; use GraphQL pagination for a complete audit.",
        )
      }
    } catch (error) {
      handleError(error, "Failed to read issue history")
    }
  })
