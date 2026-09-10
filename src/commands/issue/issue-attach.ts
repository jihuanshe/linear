import { createIssueAttachment } from "../../operations/issue-content.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { getIssueIdentifier, requireIssueId } from "../../utils/linear.ts"
import {
  uploadFile,
  type UploadResult,
  validateFilePath,
} from "../../utils/upload.ts"
import { basename } from "@std/path"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  handleError,
  ValidationError,
  withAppliedReceipts,
} from "../../utils/errors.ts"

/** Quote a value for safe copy-paste into a shell command. */
function quoteForShell(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

export const attachCommand = withUsageMetadata(new Command(), { writes: true })
  .name("attach")
  .description(
    "Create a sidebar attachment on an issue (images do not render inline)",
  )
  .arguments("<issueId:string> <filepath:string>")
  .option("--json", "Output a JSON write result with the attachment")
  .option("-t, --title <title:string>", "Custom title for the attachment")
  .option(
    "-c, --comment <body:string>",
    "Create a linked comment with this body; the file remains a sidebar attachment",
  )
  .option(
    "--public",
    "Upload images to a public, unauthenticated URL (default: private, workspace-members only)",
  )
  .action(async (options, issueId, filepath) => {
    const { title, comment, public: makePublic, json } = options

    let uploadResult: UploadResult | undefined
    try {
      const resolvedIdentifier = await getIssueIdentifier(issueId)
      if (!resolvedIdentifier) {
        throw new ValidationError(
          "Could not determine issue identifier",
          { suggestion: "Please provide an issue identifier like 'ENG-123'." },
        )
      }

      // Validate file exists
      await validateFilePath(filepath)

      // Get the issue UUID (attachmentCreate needs UUID, not identifier)
      const issueUuid = await requireIssueId(resolvedIdentifier)

      // Upload the file
      uploadResult = await uploadFile(filepath, {
        showProgress: shouldShowSpinner() && !json,
        makePublic,
      })
      if (json) console.error(`✓ Uploaded ${uploadResult.filename}`)
      else console.log(`✓ Uploaded ${uploadResult.filename}`)
      if (uploadResult.public) {
        console.warn(
          `⚠ Uploaded to a public URL readable by anyone: ${uploadResult.assetUrl}`,
        )
      }

      const { attachment } = await createIssueAttachment(issueUuid, {
        url: uploadResult.assetUrl,
        title: title || basename(filepath),
        commentBody: comment,
      })
      if (json) {
        printWriteResult({ attachment }, {
          receipts: [{ kind: "upload", ...uploadResult }],
        })
        return
      }
      console.log(`✓ Sidebar attachment created: ${attachment.title}`)
      console.log(attachment.url)
      if (uploadResult.contentType.startsWith("image/")) {
        const suggested = [
          "linear issue comment add",
          resolvedIdentifier,
          "--attach",
          quoteForShell(filepath),
          ...(makePublic ? ["--public"] : []),
        ].join(" ")
        console.log(
          `Hint: Sidebar attachments do not render images inline. For inline display, run: ${suggested}`,
        )
      }
    } catch (error) {
      handleError(
        withAppliedReceipts(
          error,
          uploadResult == null ? [] : [{ kind: "upload", ...uploadResult }],
        ),
        "Failed to attach file",
      )
    }
  })
