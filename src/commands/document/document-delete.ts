import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Confirm } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"
import {
  type BulkOperationResult,
  collectBulkIds,
  executeBulkOperations,
  isBulkMode,
  printBulkSummary,
} from "../../utils/bulk.ts"
import {
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
  WriteError,
  writeErrorFrom,
} from "../../utils/errors.ts"

interface DocumentDeleteResult extends BulkOperationResult {
  title?: string
}

export const deleteCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--yes",
  outputModes: ["human", "json"],
})
  .name("delete")
  .option("--json", "Output a JSON write result")
  .description("Delete a document (moves to trash)")
  .alias("d")
  .arguments("[documentId:string]")
  .option("-y, --yes", "Skip confirmation prompt")
  .option(
    "--bulk <ids...:string>",
    "Delete multiple documents by slug or ID",
  )
  .option(
    "--bulk-file <file:string>",
    "Read document slugs/IDs from a file (one per line)",
  )
  .option("--bulk-stdin", "Read document slugs/IDs from stdin")
  .action(
    async (
      { yes, bulk, bulkFile, bulkStdin, json },
      documentId,
    ) => {
      setMachineOutput(json ?? false)
      try {
        const client = getGraphQLClient()

        // Check if bulk mode
        if (isBulkMode({ bulk, bulkFile, bulkStdin })) {
          await handleBulkDelete(client, {
            bulk,
            bulkFile,
            bulkStdin,
            yes,
            json,
          })
          return
        }

        // Single mode requires documentId
        if (!documentId) {
          throw new ValidationError("Document ID required", {
            suggestion: "Use --bulk for multiple documents.",
          })
        }

        await handleSingleDelete(client, documentId, { yes, json })
      } catch (error) {
        handleError(error, "Failed to delete document")
      }
    },
  )

async function handleSingleDelete(
  client: ReturnType<typeof getGraphQLClient>,
  documentId: string,
  options: { yes?: boolean; json?: boolean },
): Promise<void> {
  const { yes, json } = options

  // Get document details for confirmation message
  const detailsQuery = gql(`
    query GetDocumentForDelete($id: String!) {
      document(id: $id) {
        id
        slugId
        title
      }
    }
  `)

  const documentDetails = await client.request(detailsQuery, { id: documentId })

  if (!documentDetails?.document) {
    throw new NotFoundError("Document", documentId)
  }

  const document = documentDetails.document

  // Confirm deletion
  if (!yes) {
    if (json || !Deno.stdin.isTerminal()) {
      throw new ValidationError("Interactive confirmation required", {
        suggestion: "Use --yes to skip.",
      })
    }
    const confirmed = await Confirm.prompt({
      message: `Are you sure you want to delete "${document.title}"?`,
      default: false,
    })

    if (!confirmed) {
      console.log("Delete cancelled.")
      return
    }
  }

  // Delete the document (moves to trash)
  const deleteMutation = gql(`
    mutation DeleteDocument($id: String!) {
      documentDelete(id: $id) {
        success
      }
    }
  `)

  const result = await client.request(deleteMutation, { id: document.id })
    .catch((error) => {
      throw writeErrorFrom(error, { id: document.id })
    })

  assertMutationSuccess(result?.documentDelete, {
    id: document.id,
    result: result?.documentDelete,
  })
  if (json) {
    printWriteResult({ id: document.id, success: true })
    return
  }

  console.log(`✓ Deleted document: ${document.title}`)
}

async function handleBulkDelete(
  client: ReturnType<typeof getGraphQLClient>,
  options: {
    bulk?: string[]
    bulkFile?: string
    bulkStdin?: boolean
    yes?: boolean
    json?: boolean
  },
): Promise<void> {
  const { yes, json } = options

  // Collect all IDs
  const ids = await collectBulkIds({
    bulk: options.bulk,
    bulkFile: options.bulkFile,
    bulkStdin: options.bulkStdin,
  })

  if (ids.length === 0) {
    throw new ValidationError("No document IDs provided for bulk delete")
  }

  if (!json) console.log(`Found ${ids.length} document(s) to delete.`)

  // Confirm bulk operation
  if (!yes) {
    if (json || !Deno.stdin.isTerminal()) {
      throw new ValidationError("Interactive confirmation required", {
        suggestion: "Use --yes to skip.",
      })
    }
    const confirmed = await Confirm.prompt({
      message: `Delete ${ids.length} document(s)?`,
      default: false,
    })

    if (!confirmed) {
      console.log("Bulk delete cancelled.")
      return
    }
  }

  // Define the delete operation
  const deleteOperation = async (
    docId: string,
  ): Promise<DocumentDeleteResult> => {
    // Get document details for display
    const detailsQuery = gql(`
      query GetDocumentForBulkDelete($id: String!) {
        document(id: $id) {
          id
          slugId
          title
        }
      }
    `)

    const details = await client.request(detailsQuery, { id: docId })
    if (!details.document?.id) throw new NotFoundError("Document", docId)
    const documentUuid = details.document.id
    const title = details.document.title

    // Delete the document
    const deleteMutation = gql(`
      mutation BulkDeleteDocument($id: String!) {
        documentDelete(id: $id) {
          success
        }
      }
    `)

    const result = await client.request(deleteMutation, { id: documentUuid })
      .catch((error) => {
        throw writeErrorFrom(error, { id: documentUuid })
      })

    assertMutationSuccess(result?.documentDelete, {
      id: documentUuid,
      result: result?.documentDelete,
    })

    return {
      id: documentUuid,
      name: title,
      title,
      success: true,
      effect: "applied",
    }
  }

  // Execute bulk operation
  const summary = await executeBulkOperations(ids, deleteOperation, {
    showProgress: !json,
  })

  // Print summary
  if (!json) {
    printBulkSummary(summary, {
      entityName: "document",
      operationName: "deleted",
      showDetails: true,
    })
  }

  // Exit with error code if any failed
  if (summary.failed > 0) {
    throw new WriteError("Bulk delete did not complete successfully", {
      effect: summary.effect,
      data: summary,
      receipts: summary.results,
    })
  }
  if (json) {
    printWriteResult(summary, {
      effect: summary.effect === "applied" ? "applied" : "none",
    })
  }
}
