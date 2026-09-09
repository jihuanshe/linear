import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Confirm } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { resolveProjectId } from "../../utils/linear.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  ValidationError,
} from "../../utils/errors.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"

const DeleteProject = gql(`
  mutation DeleteProject($id: String!) {
    projectDelete(id: $id) {
      success
      entity {
        id
        name
      }
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
  .description("Delete (trash) a Linear project")
  .arguments("<projectId:string>")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async ({ force, json }, projectId) => {
    setMachineOutput(json ?? false)
    if (!force) {
      if (json || !Deno.stdin.isTerminal()) {
        throw new ValidationError("Interactive confirmation required", {
          suggestion: "Use --force to skip confirmation.",
        })
      }
      const confirmed = await Confirm.prompt({
        message: `Are you sure you want to delete project ${projectId}?`,
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
      const resolvedId = await resolveProjectId(projectId)

      const result = await client.request(DeleteProject, {
        id: resolvedId,
      })
      spinner?.stop()

      assertMutationSuccess(result?.projectDelete, {
        id: resolvedId,
        result: result?.projectDelete,
      })
      const entity = result.projectDelete.entity
      assertMutationReceipt(entity, {
        id: resolvedId,
        result: result.projectDelete,
      }, resolvedId)
      if (json) {
        printWriteResult({ id: resolvedId, ...result?.projectDelete })
        return
      }

      const displayName = entity?.name ?? projectId
      console.log(`✓ Deleted project: ${displayName}`)
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to delete project")
    }
  })
