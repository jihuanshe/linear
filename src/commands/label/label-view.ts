import { Command } from "@cliffy/command"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { handleError } from "../../utils/errors.ts"
import { readIssueLabel } from "./label-read.ts"

export const viewCommand = new Command()
  .name("view")
  .description("View an issue label or label group by UUID")
  .arguments("<label:string>")
  .option(
    "--json",
    "Output {organization, issueLabel} for --base-file, including group type and parent",
  )
  .action(async ({ json }, id) => {
    try {
      const result = await readIssueLabel(getGraphQLClient(), id)
      if (json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      const label = result.issueLabel
      console.log(`${label.name} (${label.id})`)
      console.log(`Scope: ${label.team?.key ?? "Workspace"}`)
      console.log(
        `Type: ${
          label.isGroup
            ? `Group (${label.groupType ?? "singleSelect"})`
            : "Label"
        }`,
      )
      if (label.parent) {
        console.log(`Parent: ${label.parent.name} (${label.parent.id})`)
      }
      if (label.description) console.log(label.description)
    } catch (error) {
      handleError(error, "Failed to read label")
    }
  })
