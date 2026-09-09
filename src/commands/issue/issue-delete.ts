import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { assertPromptAllowed, Confirm } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getIssueIdentifier } from "../../utils/linear.ts"
import {
  type BulkOperationResult,
  collectBulkIds,
  executeBulkOperations,
  isBulkMode,
  printBulkSummary,
} from "../../utils/bulk.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  CliError,
  errorResult,
  handleError,
  NotFoundError,
  ValidationError,
  WriteError,
} from "../../utils/errors.ts"
import { printWriteResult } from "../../utils/write-result.ts"

const IssueDeleteDetails = gql(`
  query GetIssueDeleteDetails($id: String!) {
    issue(id: $id) { id title identifier }
  }
`)
const DeleteIssue = gql(`
  mutation DeleteIssue($id: String!) {
    issueDelete(id: $id) { success entity { id identifier title } }
  }
`)

async function resolveIssue(ref: string) {
  const identifier = await getIssueIdentifier(ref)
  if (!identifier) throw new NotFoundError("Issue", ref)
  const data = await getGraphQLClient().request(IssueDeleteDetails, {
    id: identifier,
  })
  if (!data.issue) throw new NotFoundError("Issue", ref)
  if (!data.issue.id) {
    throw new CliError("Issue lookup returned no stable identity")
  }
  return data.issue
}
async function removeIssue(issue: Awaited<ReturnType<typeof resolveIssue>>) {
  const data = await getGraphQLClient().request(DeleteIssue, { id: issue.id })
  assertMutationSuccess(data.issueDelete, data)
  assertMutationReceipt(data.issueDelete.entity, data, issue.id)
  return data.issueDelete
}

export const deleteCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--confirm",
})
  .name("delete")
  .description(
    "Delete an issue by identifier or UUID; bulk stops after an unknown outcome",
  )
  .alias("d")
  .arguments("[issueId:string]")
  .option("-y, --confirm", "Skip confirmation prompt")
  .option(
    "--bulk <ids...:string>",
    "Delete multiple issues by identifier or UUID",
  )
  .option(
    "--bulk-file <file:string>",
    "Read issue identifiers or UUIDs from a file (one per line)",
  )
  .option("--bulk-stdin", "Read issue identifiers or UUIDs from stdin")
  .option("--json", "Output deletion effects and per-item bulk results as JSON")
  .action(async ({ confirm, bulk, bulkFile, bulkStdin, json }, issueRef) => {
    try {
      if (isBulkMode({ bulk, bulkFile, bulkStdin })) {
        if (issueRef != null) {
          throw new ValidationError(
            "Do not combine an issue argument with bulk inputs",
          )
        }
        const ids = await collectBulkIds({ bulk, bulkFile, bulkStdin })
        if (!ids.length) {
          throw new ValidationError(
            "No issue identifiers or UUIDs provided for bulk delete",
          )
        }
        if (!json) console.error(`Found ${ids.length} issue(s) to delete.`)
        if (!confirm) {
          assertPromptAllowed({ suggestion: "Use --confirm to skip." })
          if (
            !await Confirm.prompt({
              message: `Delete ${ids.length} issue(s)?`,
              default: false,
              writer: Deno.stderr,
            })
          ) {
            if (json) {
              printWriteResult({ cancelled: true, ids }, { effect: "none" })
            } else console.log("Bulk delete cancelled.")
            return
          }
        }
        const summary = await executeBulkOperations(
          ids,
          async (
            ref,
          ): Promise<BulkOperationResult & { identifier: string }> => {
            const issue = await resolveIssue(ref)
            const identity = {
              id: issue.id,
              identifier: issue.identifier,
              name: `${issue.identifier}: ${issue.title}`,
            }
            try {
              const data = await removeIssue(issue)
              return { ...identity, success: true, effect: "applied", data }
            } catch (error) {
              const failure = errorResult(error)
              return {
                ...identity,
                success: false,
                effect: failure.effect,
                error: failure.error.message,
                data: failure,
              }
            }
          },
          { showProgress: !json },
        )
        if (json) {
          if (summary.failed || summary.unattempted.length) {
            throw new WriteError("Bulk issue deletion did not complete", {
              effect: summary.effect,
              data: summary,
            })
          }
          printWriteResult(summary, {
            effect: summary.effect === "applied" ? "applied" : "none",
          })
        } else {
          printBulkSummary(summary, {
            entityName: "issue",
            operationName: "deleted",
            showDetails: true,
          })
          if (summary.failed || summary.unattempted.length) Deno.exit(1)
        }
        return
      }
      if (!issueRef) {
        throw new ValidationError("Issue ID required", {
          suggestion: "Use --bulk for multiple issues.",
        })
      }
      const issue = await resolveIssue(issueRef)
      if (!confirm) {
        assertPromptAllowed({ suggestion: "Use --confirm to skip." })
        if (
          !await Confirm.prompt({
            message:
              `Are you sure you want to delete "${issue.identifier}: ${issue.title}"?`,
            default: false,
            writer: Deno.stderr,
          })
        ) {
          if (json) {
            printWriteResult({ cancelled: true, issue }, { effect: "none" })
          } else console.log("Delete cancelled.")
          return
        }
      }
      const data = await removeIssue(issue)
      if (json) printWriteResult(data)
      else {console.log(
          `✓ Successfully deleted issue: ${issue.identifier}: ${issue.title}`,
        )}
    } catch (error) {
      handleError(error, "Failed to delete issue")
    }
  })
