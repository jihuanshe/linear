import { Command } from "@cliffy/command"
import { getIssueReference } from "../../utils/linear.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export const identifierCommand = new Command()
  .name("identifier")
  .description(
    "Print the issue identifier from the current Git or Jujutsu context",
  )
  .action(async (_) => {
    try {
      const identifier = await getIssueReference()
      if (identifier) {
        console.log(identifier)
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
