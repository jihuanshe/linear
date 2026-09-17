import { linkIssueUrl } from "../../operations/issue-content.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { getIssueIdentifier, requireIssueId } from "../../utils/linear.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

function looksLikeUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://")
}

export const linkCommand = withUsageMetadata(new Command(), { writes: true })
  .name("link")
  .description("Link a URL to an issue")
  .arguments("<issueId:string> <url:string>")
  .option("--json", "Output a JSON write result with the attachment")
  .option("-t, --title <title:string>", "Custom title for the link")
  .example(
    "Link a URL to a specific issue",
    "linear issue link ENG-123 https://github.com/org/repo/pull/123",
  )
  .example(
    "Link with a custom title",
    'linear issue link ENG-123 https://example.com --title "Design doc"',
  )
  .action(async (options, issueId, url) => {
    const { title, json } = options

    try {
      if (!looksLikeUrl(url)) {
        throw new ValidationError(
          `Invalid URL: '${url}'`,
          { suggestion: "Provide a URL starting with http:// or https://." },
        )
      }

      const resolvedIdentifier = await getIssueIdentifier(issueId)
      if (!resolvedIdentifier) {
        throw new ValidationError(
          "Could not determine issue identifier",
          {
            suggestion: "Please provide an issue identifier like 'ENG-123'.",
          },
        )
      }

      // attachmentLinkURL needs a UUID
      const issueUuid = await requireIssueId(resolvedIdentifier)

      const { attachment } = await linkIssueUrl(issueUuid, {
        url,
        title,
      })
      if (json) {
        printWriteResult({ attachment })
        return
      }
      console.log(`✓ Linked to ${resolvedIdentifier}: ${attachment.title}`)
    } catch (error) {
      handleError(error, "Failed to link URL")
    }
  })
