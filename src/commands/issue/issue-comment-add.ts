import {
  composeCommentBody,
  createIssueComment,
} from "../../operations/issue-content.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { withMarkdownHint } from "../../utils/markdown-help.ts"
import { openEditor } from "../../utils/editor.ts"
import { readTextSource } from "../../utils/text-source.ts"
import { requireIssueId } from "../../utils/linear.ts"
import {
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
  .arguments("<issueId:string>")
  .option("-b, --body <text:string>", "Comment body text", {
    preserveEmpty: true,
  })
  .option(
    "--body-file <path:string>",
    "Read UTF-8 comment body from a file (- for stdin)",
    { preserveEmpty: true },
  )
  .option(
    "--edit",
    "Open an editor, optionally seeded by --body or --body-file",
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
      edit,
    } = options

    const uploadedFiles: UploadResult[] = []
    try {
      if (!issueId.trim()) {
        throw new ValidationError("Issue identifier cannot be empty")
      }
      if (json && edit) {
        throw new ValidationError("--json cannot be combined with --edit")
      }
      let commentBody = await readTextSource("body", body, bodyFile)
      if (parent != null && !parent.trim()) {
        throw new ValidationError("Parent comment reference cannot be empty")
      }
      if (attach?.some((path) => path === "")) {
        throw new ValidationError("Attachment file path cannot be empty")
      }
      if (edit) commentBody = await openEditor(commentBody)
      composeCommentBody(commentBody)
      const attachments = attach || []
      if (makePublic && attachments.length === 0) {
        throw new ValidationError(
          "--public requires at least one --attach",
          { suggestion: "Add --attach <file> to upload, or remove --public." },
        )
      }
      if (attachments.length === 0 && commentBody == null) {
        throw new ValidationError(
          "Provide --body, --body-file, --attach, or --edit",
          {
            suggestion:
              "Provide the comment content explicitly when producing machine-readable output.",
          },
        )
      }

      const prepared = await prepareUploads(attachments, { makePublic })
      const issueUuid = await requireIssueId(issueId)

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

      const { comment } = await createIssueComment(issueUuid, {
        body: composeCommentBody(commentBody, uploadedFiles),
        parentId: parent,
      })
      if (json) {
        printWriteResult({ comment }, {
          receipts: uploadedFiles.map((file) => ({ kind: "upload", ...file })),
        })
        return
      }

      console.log(`✓ Comment added to ${issueId}`)
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
