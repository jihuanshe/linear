import { createIssueAttachment } from "../../operations/issue-content.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { getIssueReference, requireIssueId } from "../../utils/linear.ts"
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
    "Create a sidebar attachment on an issue (images do not render inline). Accepts an issue UUID, identifier (e.g. ENG-123), number in the configured team, or Linear URL.",
  )
  .arguments("<issue:string> <path:string>")
  .option("--json", "Output a JSON write result with the attachment")
  .option("-t, --title <title:string>", "Custom title for the attachment")
  .option(
    "--public",
    "Upload images to a public, unauthenticated URL (default: private, workspace-members only)",
  )
  .action(async (options, issueArg, path) => {
    const { title, public: makePublic, json } = options

    let uploadResult: UploadResult | undefined
    try {
      if (!issueArg.trim()) {
        throw new ValidationError("Issue reference cannot be empty")
      }

      // Validate file exists
      await validateFilePath(path)

      // Get the issue UUID (attachmentCreate needs UUID, not identifier)
      const issueReference = await getIssueReference(issueArg)
      if (!issueReference) {
        throw new ValidationError("Could not determine issue reference", {
          suggestion:
            "Provide an Issue UUID, identifier such as ENG-123, or Linear Issue URL.",
        })
      }
      const issueUuid = await requireIssueId(issueReference)

      // Upload the file
      uploadResult = await uploadFile(path, {
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
        title: title || basename(path),
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
          issueReference,
          "--attach",
          quoteForShell(path),
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
