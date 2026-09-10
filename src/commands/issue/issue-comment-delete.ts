import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { assertMutationSuccess, handleError } from "../../utils/errors.ts"
import { assertPromptAllowed, Confirm } from "../../utils/prompt.ts"
import { printWriteResult } from "../../utils/write-result.ts"

const DeleteComment = gql(`
  mutation DeleteComment($id: String!) {
    commentDelete(id: $id) { success }
  }
`)

export const commentDeleteCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--confirm",
})
  .name("delete")
  .description("Delete a comment")
  .arguments("<commentId:string>")
  .option("-y, --confirm", "Skip confirmation prompt")
  .option("--json", "Output the confirmed deletion as JSON")
  .action(async ({ confirm, json }, commentId) => {
    try {
      if (!confirm) {
        assertPromptAllowed({ suggestion: "Use --confirm to skip." })
        if (
          !await Confirm.prompt({
            message: `Are you sure you want to delete comment ${commentId}?`,
            default: false,
            writer: Deno.stderr,
          })
        ) {
          if (json) {
            printWriteResult({ id: commentId, cancelled: true }, {
              effect: "none",
            })
          } else console.log("Delete cancelled.")
          return
        }
      }
      const data = await getGraphQLClient().request(DeleteComment, {
        id: commentId,
      })
      assertMutationSuccess(data.commentDelete, data)
      if (json) printWriteResult({ id: commentId, ...data.commentDelete })
      else console.log("✓ Comment deleted")
    } catch (error) {
      handleError(error, "Failed to delete comment")
    }
  })
