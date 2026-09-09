import { Command } from "@cliffy/command"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { handleError } from "../../utils/errors.ts"
import { readComment } from "./issue-comment-read.ts"

export const commentViewCommand = new Command()
  .name("view")
  .description(
    "Read one comment, including the original body and stable identity",
  )
  .arguments("<commentId:string>")
  .option("-j, --json", "Output {organization, comment} for --base-file")
  .action(async ({ json }, id) => {
    try {
      const result = await readComment(getGraphQLClient(), id)
      if (json) console.log(JSON.stringify(result, null, 2))
      else console.log(result.comment!.body)
    } catch (error) {
      handleError(error, "Failed to view comment")
    }
  })
