import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { withMarkdownHint } from "../../utils/markdown-help.ts"
import { Input } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  ValidationError,
} from "../../utils/errors.ts"
import {
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
    "Read comment body from a file (preferred for markdown content)",
  )
  .option(
    "-j, --json",
    "Output a JSON write result; the comment is in data.comment",
  )
  .option(
    "--base-file <path:string>",
    "Original view --json output, saved before preparing the update",
  )
  .option(
    "--unprotected",
    "Explicitly skip original-value comparison; domain checks still apply",
  )
  .option(
    "--expect-field <field:string>",
    "Also require this API field to match the original basis",
    { collect: true },
  )
  .action(async (options, commentId) => {
    const { body, bodyFile, json } = options

    try {
      // Validate that body and bodyFile are not both provided
      if (body != null && bodyFile != null) {
        throw new ValidationError(
          "Cannot specify both --body and --body-file",
        )
      }

      // Read body from file if provided
      let newBody = body
      if (bodyFile) {
        try {
          newBody = await Deno.readTextFile(bodyFile)
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

      if (json && !newBody?.trim()) {
        throw new ValidationError(
          "JSON mode requires --body or --body-file",
          {
            suggestion:
              "Provide the replacement body explicitly; JSON mode never prompts for input.",
          },
        )
      }

      let original = options.baseFile
        ? await loadBasisFile(options.baseFile)
        : undefined
      if (newBody !== undefined || original != null || options.unprotected) {
        validateReplacementOptions({
          original,
          unprotected: options.unprotected,
          expectFields: options.expectField,
        })
      }
      const client = getGraphQLClient()
      if (newBody === undefined) {
        if (!Deno.stdin.isTerminal()) {
          throw new ValidationError(
            "Provide --body or --body-file in non-interactive mode",
          )
        }
        const initial = await readComment(client, commentId)
        if (!options.unprotected) original ??= initial
        newBody = await Input.prompt({
          message: "New comment body",
          default: initial.comment!.body,
        })
      }
      if (!newBody.trim()) {
        throw new ValidationError("Comment body cannot be empty")
      }

      const current = await readComment(client, commentId)
      const id = current.comment!.id
      const plan = prepareReplacement({
        objectKey: "comment",
        targetId: id,
        original,
        current,
        desired: { body: newBody },
        fields: { body: scalarField("body") },
        unprotected: options.unprotected,
        expectFields: options.expectField,
      })
      if (Object.keys(plan.input).length === 0) {
        if (json) {
          printWriteResult({ comment: current.comment }, {
            effect: "none",
            fields: plan.fields,
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
        printWriteResult({ comment }, { fields: plan.fields })
      } else {
        console.log("✓ Comment updated")
        console.log(comment.url)
      }
    } catch (error) {
      handleError(error, "Failed to update comment")
    }
  })
