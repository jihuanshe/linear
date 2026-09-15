import { Command } from "@cliffy/command"
import { dirname, join, resolve } from "@std/path"
import {
  fetchIssueDetailsRaw,
  getIssueIdentifier,
  isLinearUuid,
} from "../../utils/linear.ts"
import {
  assertReadIdentity,
  assertReadOrganization,
} from "../../utils/read-identity.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export const exportCommand = new Command()
  .name("export")
  .description(
    "Save an Issue's original JSON with all comments and attachments, and its exact Markdown draft for local editing, without changing Linear.\n\nCreates original.json and desired.md in a new directory. Read the saved discussion before editing desired.md, then use issue update --base-file original.json --description-file desired.md. Markdown is not a lossless rich-text backup; see linear guide markdown.",
  )
  .arguments("<issueId:string>")
  .option(
    "--output <directory:string>",
    "New directory for the editing files",
    {
      required: true,
      preserveEmpty: true,
    },
  )
  .option("--json", "Output saved paths and stable Issue identity as JSON")
  .action(async ({ output, json }, issueId) => {
    try {
      if (!output.trim() || !issueId.trim()) {
        throw new ValidationError("Issue and output directory cannot be empty")
      }
      const directory = resolve(output)
      const resolvedId = await getIssueIdentifier(issueId)
      if (!resolvedId) {
        throw new ValidationError("Could not determine issue identifier")
      }
      const original = await fetchIssueDetailsRaw(resolvedId, true, true)
      if (isLinearUuid(resolvedId)) {
        assertReadIdentity(
          original.issue,
          resolvedId,
          original.organization,
          original.organization?.id ?? "",
          "Issue",
        )
      } else {
        assertReadOrganization(original.organization, "Issue")
      }
      if (
        !original.organization?.id || !original.issue.id ||
        original.issue.description === undefined
      ) {
        throw new ValidationError(
          "Issue read is missing identity or description",
        )
      }
      await Deno.mkdir(dirname(directory), { recursive: true })
      // Reserve the final directory exclusively after the complete read.
      await Deno.mkdir(directory)
      const baseFile = join(directory, "original.json")
      const descriptionFile = join(directory, "desired.md")
      await Deno.writeTextFile(
        baseFile,
        JSON.stringify(original, null, 2) + "\n",
        {
          createNew: true,
        },
      )
      await Deno.writeTextFile(
        descriptionFile,
        original.issue.description ?? "",
        {
          createNew: true,
        },
      )
      if (json) {
        console.log(JSON.stringify(
          {
            organization: original.organization,
            issue: {
              id: original.issue.id,
              identifier: original.issue.identifier,
            },
            baseFile,
            descriptionFile,
          },
          null,
          2,
        ))
      } else {
        console.log(`Saved ${original.issue.identifier}: ${directory}`)
        console.log("In that directory, edit desired.md, then run:")
        console.log(
          `linear issue update ${original.issue.id} --base-file original.json --description-file desired.md`,
        )
      }
    } catch (error) {
      handleError(error, "Failed to export issue")
    }
  })
