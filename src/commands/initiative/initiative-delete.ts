import { resolveInitiativeId } from "./initiative-resolve.ts"
import { readInitiative } from "./initiative-read.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Confirm, Input } from "../../utils/prompt.ts"
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
  handleError,
  NotFoundError,
  ValidationError,
  WriteError,
  writeErrorFrom,
} from "../../utils/errors.ts"

interface InitiativeDeleteResult extends BulkOperationResult {
  name: string
}

export const deleteCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--force",
  outputModes: ["human", "json"],
})
  .name("delete")
  .option("--json", "Output a JSON write result")
  .description("Move a Linear initiative to trash")
  .arguments("[initiativeId:string]")
  .option("-y, --force", "Skip confirmation prompt")
  .option(
    "--bulk <ids...:string>",
    "Delete multiple initiatives by ID, slug, or name",
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
        await handleBulkDelete(client, {
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

      await handleSingleDelete(client, initiativeId, { force, json })
    },
  )

async function handleSingleDelete(
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
  const projectCount = initiative.projects?.nodes?.length || 0

  // Warn about linked projects
  if (!json && projectCount > 0) {
    console.log(
      `\n⚠️  Initiative "${initiative.name}" has ${projectCount} linked project(s).`,
    )
    console.log("Deleting the initiative will unlink these projects.\n")
  }

  // Confirm deletion with typed confirmation for safety
  if (!force) {
    if (json || !Deno.stdin.isTerminal()) {
      throw new ValidationError(
        "Interactive confirmation required. Use --force to skip.",
      )
    }
    console.log(`\n⚠️  This action moves the initiative to trash.\n`)

    const confirmed = await Confirm.prompt({
      message: `Are you sure you want to move "${initiative.name}" to trash?`,
      default: false,
    })

    if (!confirmed) {
      console.log("Delete cancelled.")
      return
    }

    // Require typing the initiative name for extra safety
    const typedName = await Input.prompt({
      message: `Type the initiative name to confirm deletion:`,
    })

    if (typedName !== initiative.name) {
      console.log("Name does not match. Delete cancelled.")
      return
    }
  }

  const { Spinner } = await import("@std/cli/unstable-spinner")
  const showSpinner = !json && shouldShowSpinner()
  const spinner = showSpinner ? new Spinner() : null
  spinner?.start()

  // Delete the initiative
  const deleteMutation = gql(`
    mutation DeleteInitiative($id: String!) {
      initiativeDelete(id: $id) {
        success
      }
    }
  `)

  try {
    const result = await client.request(deleteMutation, { id: resolvedId })
      .catch((error) => {
        throw writeErrorFrom(error, { id: resolvedId })
      })

    spinner?.stop()

    assertMutationSuccess(result?.initiativeDelete, {
      id: resolvedId,
      result: result?.initiativeDelete,
    })
    if (json) {
      printWriteResult({ id: resolvedId, success: true })
      return
    }

    console.log(`✓ Moved initiative to trash: ${initiative.name}`)
  } catch (error) {
    spinner?.stop()
    handleError(error, "Failed to delete initiative")
  }
}

async function handleBulkDelete(
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
    throw new ValidationError("No initiative IDs provided for bulk delete.")
  }

  if (!json) {
    console.log(`Found ${ids.length} initiative(s) to delete.`)
    console.log(`\n⚠️  This action moves the initiatives to trash.\n`)
  }

  // Confirm bulk operation
  if (!force) {
    if (json || !Deno.stdin.isTerminal()) {
      throw new ValidationError(
        "Interactive confirmation required. Use --force to skip.",
      )
    }
    const confirmed = await Confirm.prompt({
      message: `Move ${ids.length} initiative(s) to trash?`,
      default: false,
    })

    if (!confirmed) {
      console.log("Bulk delete cancelled.")
      return
    }
  }

  // Define the delete operation
  const deleteOperation = async (
    idOrSlugOrName: string,
  ): Promise<InitiativeDeleteResult> => {
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

    const details = await readInitiative(client, resolvedId)
    if (!details.initiative?.id) {
      throw new NotFoundError("Initiative", idOrSlugOrName)
    }
    name = details.initiative.name

    // Delete the initiative
    const deleteMutation = gql(`
      mutation BulkDeleteInitiative($id: String!) {
        initiativeDelete(id: $id) {
          success
        }
      }
    `)

    const result = await client.request(deleteMutation, { id: resolvedId })
      .catch((error) => {
        throw writeErrorFrom(error, { id: resolvedId })
      })

    assertMutationSuccess(result?.initiativeDelete, {
      id: resolvedId,
      result: result?.initiativeDelete,
    })

    return {
      id: resolvedId,
      name,
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
      entityName: "initiative",
      operationName: "moved to trash",
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
