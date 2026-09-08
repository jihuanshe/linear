import { Command } from "@cliffy/command"
import { fetchIssueDetailsRaw, getIssueIdentifier } from "../../utils/linear.ts"
import { formatIssueDescription } from "../../utils/jj.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export const describeCommand = new Command()
  .name("describe")
  .description("Print the issue title and Linear-issue trailer")
  .arguments("[issueId:string]")
  .option(
    "-r, --references, --ref",
    "Use 'References' instead of 'Fixes' for the Linear issue link",
  )
  .action(async (options, issueId) => {
    try {
      const resolvedId = await getIssueIdentifier(issueId)
      if (!resolvedId) {
        throw new ValidationError(
          "Could not determine issue identifier",
          { suggestion: "Please provide an issue identifier like 'ENG-123'." },
        )
      }

      const { title, url } = await fetchIssueDetailsRaw(resolvedId)

      const magicWord = options.references ? "References" : "Fixes"
      console.log(formatIssueDescription(resolvedId, title, url, magicWord))
    } catch (error) {
      handleError(error, "Failed to get issue description")
    }
  })
