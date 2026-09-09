import { resolveInitiativeId } from "./initiative-resolve.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Confirm } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

export const unarchiveCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--force",
  outputModes: ["human", "json"],
})
  .name("unarchive")
  .option("--json", "Output a JSON write result")
  .description("Unarchive a Linear initiative")
  .arguments("<initiativeId:string>")
  .option("-y, --force", "Skip confirmation prompt")
  .action(async ({ force, json }, initiativeId) => {
    setMachineOutput(json ?? false)
    const client = getGraphQLClient()

    // Resolve initiative ID
    const resolvedId = await resolveInitiativeId(client, initiativeId, true)
    if (!resolvedId) {
      throw new NotFoundError("Initiative", initiativeId)
    }

    // Get initiative details for confirmation message (must include archived)
    const detailsQuery = gql(`
      query GetInitiativeForUnarchive($id: ID!) {
        initiatives(filter: { id: { eq: $id } }, includeArchived: true) {
          nodes {
            id
            slugId
            name
            archivedAt
          }
        }
      }
    `)

    let initiativeDetails
    try {
      initiativeDetails = await client.request(detailsQuery, {
        id: resolvedId,
      })
    } catch (error) {
      handleError(error, "Failed to fetch initiative details")
    }

    if (!initiativeDetails?.initiatives?.nodes?.length) {
      throw new NotFoundError("Initiative", initiativeId)
    }

    const initiative = initiativeDetails.initiatives.nodes[0]

    // Check if already unarchived
    if (!initiative.archivedAt) {
      if (json) {
        printWriteResult(initiative, { effect: "none" })
        return
      }
      console.log(`Initiative "${initiative.name}" is not archived.`)
      return
    }

    // Confirm unarchive
    if (!force) {
      if (json || !Deno.stdin.isTerminal()) {
        throw new ValidationError(
          "Interactive confirmation required. Use --force to skip.",
        )
      }
      const confirmed = await Confirm.prompt({
        message: `Are you sure you want to unarchive "${initiative.name}"?`,
        default: true,
      })

      if (!confirmed) {
        console.log("Unarchive cancelled.")
        return
      }
    }

    const { Spinner } = await import("@std/cli/unstable-spinner")
    const showSpinner = !json && shouldShowSpinner()
    const spinner = showSpinner ? new Spinner() : null
    spinner?.start()

    // Unarchive the initiative
    const unarchiveMutation = gql(`
      mutation UnarchiveInitiative($id: String!) {
        initiativeUnarchive(id: $id) {
          success
          entity {
            id
            slugId
            name
            url
          }
        }
      }
    `)

    try {
      const result = await client.request(unarchiveMutation, {
        id: resolvedId,
      })

      spinner?.stop()

      assertMutationSuccess(result?.initiativeUnarchive, {
        id: resolvedId,
        result: result?.initiativeUnarchive,
      })

      const unarchived = result?.initiativeUnarchive.entity
      assertMutationReceipt(unarchived, {
        id: resolvedId,
        result: result?.initiativeUnarchive,
      }, resolvedId)
      if (json) {
        printWriteResult(unarchived)
        return
      }
      console.log(`✓ Unarchived initiative: ${unarchived?.name}`)
      if (unarchived?.url) {
        console.log(unarchived.url)
      }
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to unarchive initiative")
    }
  })
