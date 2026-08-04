import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { CliError, handleError } from "../../utils/errors.ts"
import { assertPromptAllowed, Confirm } from "../../utils/prompt.ts"

export const commentDeleteCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--confirm",
})
  .name("delete")
  .description("Delete a comment")
  .arguments("<commentId:string>")
  .option("-y, --confirm", "Skip confirmation prompt")
  .action(async ({ confirm }, commentId) => {
    try {
      if (!confirm) {
        assertPromptAllowed({ suggestion: "Use --confirm to skip." })
        const confirmed = await Confirm.prompt({
          message: `Are you sure you want to delete comment ${commentId}?`,
          default: false,
        })
        if (!confirmed) {
          console.log("Delete cancelled.")
          return
        }
      }

      const mutation = gql(`
        mutation DeleteComment($id: String!) {
          commentDelete(id: $id) {
            success
          }
        }
      `)

      const client = getGraphQLClient()
      const data = await client.request(mutation, { id: commentId })

      if (!data.commentDelete.success) {
        throw new CliError("Failed to delete comment")
      }

      console.log("✓ Comment deleted")
    } catch (error) {
      handleError(error, "Failed to delete comment")
    }
  })
