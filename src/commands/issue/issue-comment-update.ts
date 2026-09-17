import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { withMarkdownHint } from "../../utils/markdown-help.ts"
import { openEditor } from "../../utils/editor.ts"
import { readTextSource } from "../../utils/text-source.ts"
import { composeCommentBody } from "../../operations/issue-content.ts"
import {
  prepareUploads,
  uploadFile,
  type UploadResult,
} from "../../utils/upload.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  ValidationError,
  withAppliedReceipts,
} from "../../utils/errors.ts"
import {
  asRecord,
  loadBasisFile,
  prepareReplacement,
  scalarField,
  validateReplacementOptions,
} from "../../utils/replacement.ts"
import { readComment } from "./issue-comment-read.ts"
import { printWriteResult } from "../../utils/write-result.ts"

export const commentUpdateCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("update")
  .description(withMarkdownHint("Update an existing comment"))
  .arguments("<commentId:string>")
  .option("-b, --body <text:string>", "New comment body text", {
    preserveEmpty: true,
  })
  .option(
    "--body-file <path:string>",
    "Read UTF-8 comment body from a file (- for stdin)",
    { preserveEmpty: true },
  )
  .option(
    "-a, --attach <filepath:string>",
    "Upload and append a file (repeatable); without explicit body/edit, preserve the saved original body (current body with --unprotected)",
    { collect: true, preserveEmpty: true },
  )
  .option(
    "--public",
    "Upload attached images to a public, unauthenticated URL (default: private, workspace-members only)",
  )
  .option("--edit", "Open the current comment in an editor")
  .option(
    "-j, --json",
    "Output a JSON write result; the comment is in data.comment",
  )
  .option(
    "--base-file <path:string>",
    "Saved view --json output from before editing; compare original values before writing",
    { preserveEmpty: true },
  )
  .option(
    "--unprotected",
    "Skip original-value comparison; domain checks still apply",
  )
  .option(
    "--expect-field <field:string>",
    "Require this API field to match the saved original value (repeatable)",
    { collect: true, preserveEmpty: true },
  )
  .action(async (options, commentId) => {
    const { body, bodyFile, json, edit } = options
    const uploadedFiles: UploadResult[] = []

    try {
      if (!commentId.trim()) {
        throw new ValidationError("Comment ID cannot be empty")
      }
      const attachments = options.attach ?? []
      if (options.public && attachments.length === 0) {
        throw new ValidationError("--public requires at least one --attach")
      }
      let newBody = await readTextSource("body", body, bodyFile)
      if (edit && (json || newBody != null)) {
        throw new ValidationError(
          "--edit cannot be combined with --json, --body, or --body-file",
        )
      }

      if (!edit && newBody == null && attachments.length === 0) {
        throw new ValidationError(
          json
            ? "JSON mode requires --body, --body-file, or --attach"
            : "Provide --body, --body-file, --attach, or --edit",
        )
      }

      let original = options.baseFile != null
        ? await loadBasisFile(options.baseFile)
        : undefined
      if (
        !edit || original != null || options.unprotected ||
        options.expectField?.some((field) => !field.trim())
      ) {
        validateReplacementOptions({
          original,
          unprotected: options.unprotected,
          expectFields: options.expectField,
        })
      }
      const client = getGraphQLClient()
      if (edit) {
        const initial = await readComment(client, commentId)
        if (!options.unprotected) original ??= initial
        newBody = await openEditor(initial.comment!.body)
      }
      composeCommentBody(newBody)
      const prepared = await prepareUploads(attachments, {
        makePublic: options.public,
      })

      let current = await readComment(client, commentId)
      const id = current.comment!.id
      if (newBody == null) {
        const savedBody = options.unprotected
          ? current.comment!.body
          : asRecord(original!.comment, "Original comment").body
        if (typeof savedBody !== "string") {
          throw new ValidationError("Original comment body must be a string")
        }
        newBody = savedBody
      }
      composeCommentBody(newBody)
      // Appending depends on the whole body, even when the pre-upload body
      // happens to equal the current value. Reject drift before uploading.
      const expectFields = prepared.length > 0 && !options.unprotected
        ? [...new Set([...(options.expectField ?? []), "body"])]
        : options.expectField
      let plan = prepareReplacement({
        objectKey: "comment",
        targetId: id,
        original,
        current,
        desired: { body: newBody },
        fields: { body: scalarField("body") },
        unprotected: options.unprotected,
        expectFields,
      })
      for (const file of prepared) {
        const result = await uploadFile(file.filepath, {
          expectedSha256: file.sha256,
          showProgress: shouldShowSpinner() && !json,
          makePublic: options.public,
        })
        uploadedFiles.push(result)
        if (!json) console.log(`✓ Uploaded ${result.filename}`)
        if (result.public) {
          console.warn(
            `⚠ Uploaded to a public URL readable by anyone: ${result.assetUrl}`,
          )
        }
      }
      if (uploadedFiles.length > 0) {
        current = await readComment(client, id)
        plan = prepareReplacement({
          objectKey: "comment",
          targetId: id,
          original,
          current,
          desired: { body: composeCommentBody(newBody, uploadedFiles) },
          fields: { body: scalarField("body") },
          unprotected: options.unprotected,
          expectFields,
        })
      }
      const receipts = uploadedFiles.map((file) => ({
        kind: "upload",
        ...file,
      }))
      if (Object.keys(plan.input).length === 0) {
        if (json) {
          printWriteResult({ comment: current.comment }, {
            effect: receipts.length > 0 ? "applied" : "none",
            fields: plan.fields,
            ...(receipts.length > 0 ? { receipts } : {}),
          })
        } else console.log("No changes needed")
        return
      }

      const mutation = gql(`
        mutation UpdateComment($id: String!, $input: CommentUpdateInput!) {
          commentUpdate(id: $id, input: $input) {
            success
            comment {
              id
              body
              updatedAt
              url
              user {
                name
                displayName
              }
            }
          }
        }
      `)

      const data = await client.request(mutation, {
        id,
        input: plan.input,
      })

      assertMutationSuccess(data.commentUpdate, data)
      const comment = data.commentUpdate.comment
      assertMutationReceipt(comment, data, id)

      if (json) {
        printWriteResult({ comment }, {
          fields: plan.fields,
          ...(receipts.length > 0 ? { receipts } : {}),
        })
      } else {
        console.log("✓ Comment updated")
        console.log(comment.url)
      }
    } catch (error) {
      handleError(
        withAppliedReceipts(
          error,
          uploadedFiles.map((file) => ({ kind: "upload", ...file })),
        ),
        "Failed to update comment",
      )
    }
  })
