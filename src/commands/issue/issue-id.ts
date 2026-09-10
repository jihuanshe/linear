import { Command } from "@cliffy/command"
import { getIssueIdentifier } from "../../utils/linear.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export const idCommand = new Command()
  .name("id")
  .description(
    "Print the issue identifier from the current Git or Jujutsu context",
  )
  .action(async (_) => {
    try {
      const resolvedId = await getIssueIdentifier()
      if (resolvedId) {
        console.log(resolvedId)
      } else {
        throw new ValidationError(
          "Could not determine issue identifier",
          {
            suggestion:
              "Run from a Git branch or Jujutsu change containing an issue identifier such as ENG-123.",
          },
        )
      }
    } catch (error) {
      handleError(error, "Failed to get issue identifier")
    }
  })
