import { Command } from "@cliffy/command"
import { getIssueReference } from "../../utils/linear.ts"
import { readIssueHeader } from "../../utils/issue-read.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export const urlCommand = new Command()
  .name("url")
  .description(
    "Print the issue URL by UUID, identifier (e.g. ENG-123), number in the configured team, or Linear URL; omit to use the current Git or Jujutsu context",
  )
  .arguments("[issue:string]")
  .action(async (_, issueArg) => {
    try {
      const issueReference = await getIssueReference(issueArg)
      if (!issueReference) {
        throw new ValidationError(
          "Could not determine issue reference",
          {
            suggestion:
              "Provide an Issue UUID, identifier such as ENG-123, or Linear Issue URL.",
          },
        )
      }
      const { url } = await readIssueHeader(issueReference)
      console.log(url)
    } catch (error) {
      handleError(error, "Failed to get issue URL")
    }
  })
