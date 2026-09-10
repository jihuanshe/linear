import { resolveInitiativeId } from "./initiative-resolve.ts"
import { readInitiative } from "./initiative-read.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Confirm } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import {
  type BulkOperationResult,
  collectBulkIds,
  executeBulkOperations,
  isBulkMode,
  printBulkSummary,
} from "../../utils/bulk.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"
import {
  assertMutationSuccess,
  errorResult,
  handleError,
  NotFoundError,
  ValidationError,
  WriteError,
} from "../../utils/errors.ts"

interface InitiativeArchiveResult extends BulkOperationResult {
  name: string
}

export const archiveCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--force",
  outputModes: ["human", "json"],
})
  .name("archive")
  .option("--json", "Output a JSON write result")
  .description("Archive a Linear initiative")
  .arguments("[initiativeId:string]")
  .option("-y, --force", "Skip confirmation prompt")
  .option(
    "--bulk <ids...:string>",
    "Archive multiple initiatives by ID, slug, or name",
  )
  .option(
    "--bulk-file <file:string>",
    "Read initiative IDs from a file (one per line)",
  )
  .option("--bulk-stdin", "Read initiative IDs from stdin")
  .action(
    async (
      { force, bulk, bulkFile, bulkStdin, json },
      initiativeId,
    ) => {
      setMachineOutput(json ?? false)
      const client = getGraphQLClient()

      // Check if bulk mode
      if (isBulkMode({ bulk, bulkFile, bulkStdin })) {
        await handleBulkArchive(client, {
          bulk,
          bulkFile,
          bulkStdin,
          force,
          json,
        })
        return
      }

      // Single mode requires initiativeId
      if (!initiativeId) {
        throw new ValidationError(
          "Initiative ID required. Use --bulk for multiple initiatives.",
        )
      }

      await handleSingleArchive(client, initiativeId, { force, json })
    },
  )

async function handleSingleArchive(
  client: ReturnType<typeof getGraphQLClient>,
  initiativeId: string,
  options: { force?: boolean; json?: boolean },
): Promise<void> {
  const { force, json } = options

  // Resolve initiative ID
  const resolvedId = await resolveInitiativeId(client, initiativeId, true)
  if (!resolvedId) {
    throw new NotFoundError("Initiative", initiativeId)
  }

  let initiativeDetails
  try {
    initiativeDetails = await readInitiative(client, resolvedId)
  } catch (error) {
    handleError(error, "Failed to fetch initiative details")
  }

  if (!initiativeDetails?.initiative) {
    throw new NotFoundError("Initiative", initiativeId)
  }

  const initiative = initiativeDetails.initiative

  // Check if already archived
  if (initiative.archivedAt) {
    if (json) {
      printWriteResult(initiative, { effect: "none" })
      return
    }
    console.log(`Initiative "${initiative.name}" is already archived.`)
    return
  }

  // Confirm archival
  if (!force) {
    if (json || !Deno.stdin.isTerminal()) {
      throw new ValidationError(
        "Interactive confirmation required. Use --force to skip.",
      )
    }
    const confirmed = await Confirm.prompt({
      message: `Archive initiative "${initiative.name}"?`,
      default: true,
    })

    if (!confirmed) {
      console.log("Archive cancelled.")
      return
    }
  }

  const { Spinner } = await import("@std/cli/unstable-spinner")
  const showSpinner = !json && shouldShowSpinner()
  const spinner = showSpinner ? new Spinner() : null
  spinner?.start()

  // Archive the initiative
  const archiveMutation = gql(`
    mutation ArchiveInitiative($id: String!) {
      initiativeArchive(id: $id) {
        success
      }
    }
  `)

  try {
    const result = await client.request(archiveMutation, { id: resolvedId })
      .catch((error) => {
        throw new WriteError(errorResult(error).error.message, {
          effect: error instanceof WriteError ? error.effect : "unknown",
          data: { id: resolvedId },
          cause: error,
        })
      })

    spinner?.stop()

    assertMutationSuccess(result?.initiativeArchive, {
      id: resolvedId,
      result: result?.initiativeArchive,
    })
    if (json) {
      printWriteResult({ id: resolvedId, success: true })
      return
    }

    console.log(`✓ Archived initiative: ${initiative.name}`)
  } catch (error) {
    spinner?.stop()
    handleError(error, "Failed to archive initiative")
  }
}

async function handleBulkArchive(
  client: ReturnType<typeof getGraphQLClient>,
  options: {
    bulk?: string[]
    bulkFile?: string
    bulkStdin?: boolean
    force?: boolean
    json?: boolean
  },
): Promise<void> {
  const { force, json } = options

  // Collect all IDs
  const ids = await collectBulkIds({
    bulk: options.bulk,
    bulkFile: options.bulkFile,
    bulkStdin: options.bulkStdin,
  })

  if (ids.length === 0) {
    throw new ValidationError("No initiative IDs provided for bulk archive.")
  }

  if (!json) console.log(`Found ${ids.length} initiative(s) to archive.`)

  // Confirm bulk operation
  if (!force) {
    if (json || !Deno.stdin.isTerminal()) {
      throw new ValidationError(
        "Interactive confirmation required. Use --force to skip.",
      )
    }
    const confirmed = await Confirm.prompt({
      message: `Archive ${ids.length} initiative(s)?`,
      default: false,
    })

    if (!confirmed) {
      console.log("Bulk archive cancelled.")
      return
    }
  }

  // Define the archive operation
  const archiveOperation = async (
    idOrSlugOrName: string,
  ): Promise<InitiativeArchiveResult> => {
    // Resolve the ID
    const resolvedId = await resolveInitiativeId(client, idOrSlugOrName, true)
    if (!resolvedId) {
      return {
        id: idOrSlugOrName,
        name: idOrSlugOrName,
        success: false,
        effect: "none",
        error: "Initiative not found",
      }
    }

    let name = idOrSlugOrName
    let alreadyArchived = false

    const details = await readInitiative(client, resolvedId)
    if (!details.initiative?.id) {
      throw new NotFoundError("Initiative", idOrSlugOrName)
    }
    name = details.initiative.name
    alreadyArchived = Boolean(details.initiative.archivedAt)

    // Skip if already archived
    if (alreadyArchived) {
      return {
        id: resolvedId,
        name,
        success: true,
        effect: "none",
        error: undefined,
      }
    }

    // Archive the initiative
    const archiveMutation = gql(`
      mutation BulkArchiveInitiative($id: String!) {
        initiativeArchive(id: $id) {
          success
        }
      }
    `)

    const result = await client.request(archiveMutation, { id: resolvedId })
      .catch((error) => {
        throw new WriteError(errorResult(error).error.message, {
          effect: error instanceof WriteError ? error.effect : "unknown",
          data: { id: resolvedId },
          cause: error,
        })
      })

    assertMutationSuccess(result?.initiativeArchive, {
      id: resolvedId,
      result: result?.initiativeArchive,
    })

    return {
      id: resolvedId,
      name,
      success: true,
      effect: "applied",
    }
  }

  // Execute bulk operation
  const summary = await executeBulkOperations(ids, archiveOperation, {
    showProgress: !json,
  })

  // Print summary
  if (!json) {
    printBulkSummary(summary, {
      entityName: "initiative",
      operationName: "archived",
      showDetails: true,
    })
  }

  // Exit with error code if any failed
  if (summary.failed > 0) {
    throw new WriteError("Bulk archive did not complete successfully", {
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
