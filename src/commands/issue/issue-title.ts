import { Command } from "@cliffy/command"
import { getIssueIdentifier } from "../../utils/linear.ts"
import { readIssueHeader } from "../../utils/issue-read.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export const titleCommand = new Command()
  .name("title")
  .description("Print the issue title")
  .arguments("[issueId:string]")
  .action(async (_, issueId) => {
    try {
      const resolvedId = await getIssueIdentifier(issueId)
      if (!resolvedId) {
        throw new ValidationError(
          "Could not determine issue identifier",
          { suggestion: "Please provide an issue identifier like 'ENG-123'." },
        )
      }
      const { title } = await readIssueHeader(resolvedId)
      console.log(title)
    } catch (error) {
      handleError(error, "Failed to get issue title")
    }
  })
