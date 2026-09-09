import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Confirm } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  assertMutationSuccess,
  handleError,
  ValidationError,
} from "../../utils/errors.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"

const DeleteProjectMilestone = gql(`
  mutation DeleteProjectMilestone($id: String!) {
    projectMilestoneDelete(id: $id) {
      success
    }
  }
`)

export const deleteCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--force",
  outputModes: ["human", "json"],
})
  .name("delete")
  .option("--json", "Output a JSON write result")
  .description("Delete a project milestone")
  .arguments("<id:string>")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async ({ force, json }, id) => {
    setMachineOutput(json ?? false)
    // Confirmation prompt unless --force is used
    if (!force) {
      if (json || !Deno.stdin.isTerminal()) {
        throw new ValidationError("Interactive confirmation required", {
          suggestion: "Use --force to skip confirmation.",
        })
      }
      const confirmed = await Confirm.prompt({
        message: `Are you sure you want to delete milestone ${id}?`,
        default: false,
      })

      if (!confirmed) {
        console.log("Deletion canceled")
        return
      }
    }

    const { Spinner } = await import("@std/cli/unstable-spinner")
    const showSpinner = !json && shouldShowSpinner()
    const spinner = showSpinner ? new Spinner() : null
    spinner?.start()

    try {
      const client = getGraphQLClient()
      const result = await client.request(DeleteProjectMilestone, {
        id,
      })
      spinner?.stop()

      assertMutationSuccess(result?.projectMilestoneDelete, {
        id,
        result: result?.projectMilestoneDelete,
      })
      if (json) {
        printWriteResult({ id, success: true })
        return
      }
      console.log(`✓ Deleted milestone ${id}`)
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to delete milestone")
    }
  })
