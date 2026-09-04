import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Input } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getIssueIdentifier } from "../../utils/linear.ts"
import {
  formatAsMarkdownLink,
  getMimeType,
  resolveMakePublic,
  uploadFile,
  validateFilePath,
} from "../../utils/upload.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { CliError, handleError, ValidationError } from "../../utils/errors.ts"

export const commentAddCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  outputModes: ["human", "json"],
})
  .name("add")
  .description(
    "Add a comment or reply; images uploaded with --attach render inline",
  )
  .arguments("[issueId:string]")
  .option("-b, --body <text:string>", "Comment body text")
  .option(
    "--body-file <path:string>",
    "Read comment body from a file (preferred for markdown content)",
  )
  .option("-p, --parent <id:string>", "Parent comment ID for replies")
  .option(
    "-a, --attach <filepath:string>",
    "Upload a file and add its Markdown link to the comment (images render inline; repeatable)",
    { collect: true },
  )
  .option(
    "--public",
    "Upload attached images to a public, unauthenticated URL (default: private, workspace-members only)",
  )
  .option("-j, --json", "Output the created comment as JSON")
  .action(async (options, issueId) => {
    const {
      body,
      bodyFile,
      parent,
      attach,
      public: makePublic,
      json,
    } = options

    try {
      // Validate that body and bodyFile are not both provided
      if (body && bodyFile) {
        throw new ValidationError(
          "Cannot specify both --body and --body-file",
        )
      }

      // Read body from file if provided
      let commentBody = body
      if (bodyFile) {
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
      if (makePublic && attachments.length === 0) {
        throw new ValidationError(
          "--public requires at least one --attach",
          { suggestion: "Add --attach <file> to upload, or remove --public." },
        )
      }
      const uploadedFiles: {
        filename: string
        assetUrl: string
        isImage: boolean
      }[] = []

      if (attachments.length > 0) {
        // Validate all files exist and, if --public, that every file may be
        // uploaded publicly — before uploading any, so a mixed batch cannot
        // publish some files before failing on an unsupported one.
        for (const filepath of attachments) {
          await validateFilePath(filepath)
          resolveMakePublic(getMimeType(filepath), makePublic)
        }

        // Upload files
        for (const filepath of attachments) {
          const result = await uploadFile(filepath, {
            showProgress: shouldShowSpinner() && !json,
            makePublic,
          })
          uploadedFiles.push({
            filename: result.filename,
            assetUrl: result.assetUrl,
            isImage: result.contentType.startsWith("image/"),
          })
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
        if (json) {
          throw new ValidationError(
            "--json requires --body, --body-file, or --attach",
            {
              suggestion:
                "Provide the comment content explicitly when producing machine-readable output.",
            },
          )
        }
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
            contentType: file.isImage
              ? "image/png"
              : "application/octet-stream",
          })
        })

        if (commentBody) {
          commentBody = `${commentBody}\n\n${attachmentLinks.join("\n")}`
        } else {
          commentBody = attachmentLinks.join("\n")
        }
      }

      const mutation = gql(`
        mutation AddComment($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment {
              id
              body
              createdAt
              url
              user {
                name
                displayName
              }
            }
          }
        }
      `)

      const client = getGraphQLClient()
      const input: Record<string, unknown> = {
        body: commentBody,
        issueId: resolvedIdentifier,
      }

      if (parent) {
        input.parentId = parent
      }

      const data = await client.request(mutation, {
        input,
      })

      if (!data.commentCreate.success) {
        throw new CliError("Failed to create comment")
      }

      const comment = data.commentCreate.comment
      if (!comment) {
        throw new CliError("Comment creation failed - no comment returned")
      }

      if (json) {
        console.log(
          JSON.stringify({ issue: resolvedIdentifier, comment }, null, 2),
        )
        return
      }

      console.log(`✓ Comment added to ${resolvedIdentifier}`)
      console.log(comment.url)
    } catch (error) {
      handleError(error, "Failed to add comment")
    }
  })
