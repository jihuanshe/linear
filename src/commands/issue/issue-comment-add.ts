import { createIssueComment } from "../../operations/issue-content.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { withMarkdownHint } from "../../utils/markdown-help.ts"
import { Input } from "../../utils/prompt.ts"
import { getIssueIdentifier, requireIssueId } from "../../utils/linear.ts"
import {
  formatAsMarkdownLink,
  prepareUploads,
  uploadFile,
  type UploadResult,
} from "../../utils/upload.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  handleError,
  ValidationError,
  withAppliedReceipts,
} from "../../utils/errors.ts"

export const commentAddCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("add")
  .description(
    withMarkdownHint(
      "Add a comment or reply; images uploaded with --attach render inline",
    ),
  )
  .arguments("[issueId:string]")
  .option("-b, --body <text:string>", "Comment body text", {
    preserveEmpty: true,
  })
  .option(
    "--body-file <path:string>",
    "Read comment body from a file (preferred for markdown content)",
    { preserveEmpty: true },
  )
  .option("-p, --parent <id:string>", "Parent comment ID for replies", {
    preserveEmpty: true,
  })
  .option(
    "-a, --attach <filepath:string>",
    "Upload a file and add its Markdown link to the comment (images render inline; repeatable)",
    { collect: true, preserveEmpty: true },
  )
  .option(
    "--public",
    "Upload attached images to a public, unauthenticated URL (default: private, workspace-members only)",
  )
  .option("-j, --json", "Output a JSON write result with the comment")
  .action(async (options, issueId) => {
    const {
      body,
      bodyFile,
      parent,
      attach,
      public: makePublic,
      json,
    } = options

    const uploadedFiles: UploadResult[] = []
    try {
      // Validate that body and bodyFile are not both provided
      if (body != null && bodyFile != null) {
        throw new ValidationError(
          "Cannot specify both --body and --body-file",
        )
      }

      // Read body from file if provided
      let commentBody = body
      if (bodyFile === "") {
        throw new ValidationError("Body file path cannot be empty")
      }
      if (parent != null && !parent.trim()) {
        throw new ValidationError("Parent comment reference cannot be empty")
      }
      if (attach?.some((path) => path === "")) {
        throw new ValidationError("Attachment file path cannot be empty")
      }
      if (bodyFile != null) {
        try {
          commentBody = await Deno.readTextFile(bodyFile)
        } catch (error) {
          throw new ValidationError(
            `Failed to read body file: ${bodyFile}`,
            {
              suggestion: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          )
        }
      }

      const resolvedIdentifier = await getIssueIdentifier(issueId)
      if (!resolvedIdentifier) {
        throw new ValidationError(
          "Could not determine issue identifier",
          { suggestion: "Please provide an issue identifier like 'ENG-123'." },
        )
      }

      // Validate and upload attachments first
      const attachments = attach || []
      if (
        attachments.length === 0 && commentBody != null &&
        !commentBody.trim()
      ) {
        throw new ValidationError("Comment body cannot be empty", {
          suggestion: "Provide non-whitespace content or attach a file.",
        })
      }
      if (makePublic && attachments.length === 0) {
        throw new ValidationError(
          "--public requires at least one --attach",
          { suggestion: "Add --attach <file> to upload, or remove --public." },
        )
      }
      if (json && attachments.length === 0 && commentBody == null) {
        throw new ValidationError(
          "--json requires --body, --body-file, or --attach",
          {
            suggestion:
              "Provide the comment content explicitly when producing machine-readable output.",
          },
        )
      }

      const prepared = await prepareUploads(attachments, { makePublic })
      const issueUuid = await requireIssueId(resolvedIdentifier)

      if (prepared.length > 0) {
        // Upload files
        for (const file of prepared) {
          const result = await uploadFile(file.filepath, {
            expectedSha256: file.sha256,
            showProgress: shouldShowSpinner() && !json,
            makePublic,
          })
          uploadedFiles.push(result)
          const uploadMessage = `✓ Uploaded ${result.filename}`
          if (json) console.error(uploadMessage)
          else console.log(uploadMessage)
          if (result.public) {
            console.warn(
              `⚠ Uploaded to a public URL readable by anyone: ${result.assetUrl}`,
            )
          }
        }
      }

      // If no body provided and no attachments, prompt for it
      if (!commentBody && uploadedFiles.length === 0) {
        commentBody = await Input.prompt({
          message: "Comment body",
          default: "",
        })

        if (!commentBody.trim()) {
          throw new ValidationError("Comment body cannot be empty")
        }
      }

      // Append attachment links to comment body
      if (uploadedFiles.length > 0) {
        const attachmentLinks = uploadedFiles.map((file) => {
          return formatAsMarkdownLink({
            filename: file.filename,
            assetUrl: file.assetUrl,
            contentType: file.contentType,
          })
        })

        if (commentBody) {
          commentBody = `${commentBody}\n\n${attachmentLinks.join("\n")}`
        } else {
          commentBody = attachmentLinks.join("\n")
        }
      }

      const { comment } = await createIssueComment(issueUuid, {
        body: commentBody ?? "",
        parentId: parent,
      })
      if (json) {
        printWriteResult({ comment }, {
          receipts: uploadedFiles.map((file) => ({ kind: "upload", ...file })),
        })
        return
      }

      console.log(`✓ Comment added to ${resolvedIdentifier}`)
      console.log(comment.url)
    } catch (error) {
      handleError(
        withAppliedReceipts(
          error,
          uploadedFiles.map((file) => ({ kind: "upload", ...file })),
        ),
        "Failed to add comment",
      )
    }
  })
