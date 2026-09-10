import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { withMarkdownHint } from "../../utils/markdown-help.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { DocumentInlineCommentGuardQuery } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getEditor } from "../../utils/editor.ts"
import { resolveProjectId } from "../../utils/linear.ts"
import {
  loadBasisFile,
  prepareReplacement,
  referenceField,
  scalarField,
  validateReplacementOptions,
} from "../../utils/replacement.ts"
import { readDocument } from "./document-read.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  CliError,
  handleError,
  NotFoundError,
  ValidationError,
  WriteError,
} from "../../utils/errors.ts"

const DocumentInlineCommentGuard = gql(`
  query DocumentInlineCommentGuard($id: String!, $after: String) {
    document(id: $id) {
      id
      comments(first: 50, after: $after, orderBy: createdAt) {
        nodes {
          id
          quotedText
          resolvedAt
          archivedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`)

// An inline comment (quotedText != null) still anchored to live text — i.e. not
// resolved and not archived — is the only kind a content replacement can
// meaningfully orphan. Resolved/archived threads are closed, so detaching their
// anchor loses nothing and must not block the update.
async function getFirstActiveInlineComment(
  client: ReturnType<typeof getGraphQLClient>,
  documentId: string,
) {
  let after: string | null | undefined = null
  const seen = new Set<string>()

  while (true) {
    // Annotate with the codegen type: reusing `after` across iterations would
    // otherwise make the request's result type circular (self-referential).
    const documentData: DocumentInlineCommentGuardQuery = await client.request(
      DocumentInlineCommentGuard,
      { id: documentId, after },
    )

    if (!documentData.document) {
      throw new NotFoundError("Document", documentId)
    }

    const inlineComment = documentData.document.comments.nodes.find(
      (comment) =>
        comment.quotedText != null && comment.resolvedAt == null &&
        comment.archivedAt == null,
    )
    if (inlineComment) {
      return inlineComment
    }

    const pageInfo = documentData.document.comments.pageInfo
    if (!pageInfo.hasNextPage) {
      return undefined
    }

    if (!pageInfo.endCursor || seen.has(pageInfo.endCursor)) {
      throw new CliError(
        "Incomplete document comments: missing or repeated pagination cursor",
      )
    }
    seen.add(pageInfo.endCursor)
    after = pageInfo.endCursor
  }
}

/**
 * Open editor with initial content and return the edited content
 */
async function openEditorWithContent(
  initialContent: string,
): Promise<string> {
  const editor = await getEditor()
  if (!editor) {
    throw new ValidationError("No editor found", {
      suggestion:
        "Set EDITOR environment variable or configure git editor with: git config --global core.editor <editor>",
    })
  }

  // Create a temporary file with initial content
  const tempFile = await Deno.makeTempFile({ suffix: ".md" })

  try {
    // Write initial content to temp file
    await Deno.writeTextFile(tempFile, initialContent)

    // Open the editor
    const process = new Deno.Command(editor, {
      args: [tempFile],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })

    const { success } = await process.output()

    if (!success) {
      throw new CliError("Editor exited with an error")
    }

    // Read the content back
    return await Deno.readTextFile(tempFile)
  } catch (error) {
    if (error instanceof CliError || error instanceof ValidationError) {
      throw error
    }
    throw new CliError(
      `Failed to open editor: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  } finally {
    // Clean up the temporary file
    try {
      await Deno.remove(tempFile)
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Read piped content through EOF; empty stdin does not replace content.
 */
async function readContentFromStdin(): Promise<string | undefined> {
  // Check if stdin has data (not a TTY)
  if (Deno.stdin.isTerminal()) {
    return undefined
  }

  try {
    const content = await new Response(Deno.stdin.readable).text()
    return content.length > 0 ? content : undefined
  } catch (error) {
    throw new CliError(
      `Failed to read document content from stdin: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}

export const updateCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("update")
  .description(withMarkdownHint(
    "Update an existing document\n\n" +
      "Without --content, --content-file, or --edit, read piped Markdown through EOF.\n" +
      "Nonempty stdin can be combined with metadata updates; empty stdin leaves content unchanged.",
  ))
  .alias("u")
  .arguments("<documentId:string>")
  .option("-t, --title <title:string>", "New title for the document")
  .option(
    "-c, --content <content:string>",
    "New markdown content (inline; empty string clears it)",
    {
      preserveEmpty: true,
    },
  )
  .option(
    "-f, --content-file <path:string>",
    "Read new content from file",
    { preserveEmpty: true },
  )
  .option("--icon <icon:string>", "New icon (emoji)")
  .option(
    "--project <project:string>",
    "Attach to project (UUID, slug ID, or name)",
  )
  .option("-e, --edit", "Open current content in $EDITOR for editing")
  .option(
    "--force",
    "Update content even when document comments may lose inline anchors",
  )
  .option("--json", "Output the write result as JSON; never open an editor")
  .option(
    "--base-file <path:string>",
    "Original view --json output, saved before preparing the update",
    { preserveEmpty: true },
  )
  .option(
    "--unprotected",
    "Explicitly skip original-value comparison; inline-comment protection still requires --force",
  )
  .option(
    "--expect-field <field:string>",
    "Also require this API field to match the original basis",
    { collect: true },
  )
  .action(
    async (
      {
        title,
        content,
        contentFile,
        icon,
        project,
        edit,
        force,
        json,
        baseFile,
        unprotected,
        expectField,
      },
      documentId,
    ) => {
      try {
        if (
          [content != null, contentFile != null, !!edit].filter(Boolean)
            .length > 1
        ) {
          throw new ValidationError(
            "Use only one of --content, --content-file, or --edit",
          )
        }
        if (contentFile === "") {
          throw new ValidationError("Content file path cannot be empty")
        }
        if (json && edit) {
          throw new ValidationError(
            "JSON mode cannot open an editor; provide --content or --content-file",
          )
        }
        let original = baseFile != null
          ? await loadBasisFile(baseFile)
          : undefined
        if (!edit || original != null || unprotected) {
          validateReplacementOptions({
            original,
            unprotected,
            expectFields: expectField,
          })
        }
        const client = getGraphQLClient()

        // Build the update input
        const input: Record<string, string> = {}

        // Add title if provided
        if (title) {
          input.title = title
        }

        // Add icon if provided
        if (icon) {
          input.icon = icon
        }

        // Set the document's project. A document has a single related project
        // (DocumentUpdateInput.projectId), so this replaces any existing one.
        // (The API silently ignores projectId: null, so detaching a document
        // from its only anchor isn't supported — only re-pointing it.)
        if (project != null) {
          input.projectId = await resolveProjectId(project)
        }

        // Resolve content from various sources
        let finalContent: string | undefined

        if (content != null) {
          // Content provided inline
          finalContent = content
        } else if (contentFile != null) {
          // Content from file
          try {
            finalContent = await Deno.readTextFile(contentFile)
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
              throw new NotFoundError("File", contentFile)
            }
            throw new CliError(
              `Failed to read content file: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            )
          }
        } else if (edit) {
          // Edit mode: fetch current content and open in editor
          const documentData = await readDocument(client, documentId)

          if (!documentData?.document) {
            throw new NotFoundError("Document", documentId)
          }

          const currentContent = documentData.document.content || ""
          if (!unprotected) original ??= documentData
          console.log(`Opening ${documentData.document.title} in editor...`)

          finalContent = await openEditorWithContent(currentContent)
        } else if (!Deno.stdin.isTerminal()) {
          finalContent = await readContentFromStdin()
        }

        // Add content to input if resolved
        if (finalContent !== undefined) {
          input.content = finalContent
        }

        // Validate that at least one field is being updated
        if (Object.keys(input).length === 0) {
          throw new ValidationError("No update fields provided", {
            suggestion:
              "Use --title, --content, --content-file, --icon, --project, or --edit.",
          })
        }

        const fields = {
          title: scalarField("title"),
          content: scalarField("content"),
          icon: scalarField("icon"),
          projectId: referenceField("project"),
        }
        let current = await readDocument(client, documentId)
        const resolvedId = current.document!.id
        const prepare = (read: typeof current) =>
          prepareReplacement({
            objectKey: "document",
            targetId: resolvedId,
            original,
            current: read,
            desired: input,
            fields,
            unprotected,
            expectFields: expectField,
          })
        let plan = prepare(current)
        if (plan.input.content !== undefined && !force) {
          const comment = await getFirstActiveInlineComment(
            client,
            resolvedId,
          )

          if (comment) {
            throw new ValidationError(
              "Refusing to update document content because this document has inline comments.",
              {
                suggestion:
                  `Updating Markdown content can detach or hide Linear document comments. ` +
                  `First review comment ${comment.id} quoting "${comment.quotedText}", then rerun with --force if you accept that risk.`,
              },
            )
          }
          // The anchor read can paginate: observe replacement fields again
          // after it, so no earlier scalar snapshot permits a stale overwrite.
          current = await readDocument(client, resolvedId)
          plan = prepare(current)
        }

        if (Object.keys(plan.input).length === 0) {
          if (json) {
            printWriteResult({ document: current.document }, {
              effect: "none",
              fields: plan.fields,
            })
          } else console.log("No changes needed")
          return
        }
        const writeInput = { ...plan.input }
        // Linear currently requires LF to clear Markdown. Compare the desired
        // empty string first; encode only the actual mutation payload.
        // Evidence: https://github.com/jihuanshe/linear/pull/34
        if (writeInput.content === "") writeInput.content = "\n"

        // Execute the update
        const updateMutation = gql(`
        mutation UpdateDocument($id: String!, $input: DocumentUpdateInput!) {
          documentUpdate(id: $id, input: $input) {
            success
            document {
              id
              slugId
              title
              url
              updatedAt
              content
              icon
              project { id }
            }
          }
        }
      `)

        const result = await client.request(updateMutation, {
          id: resolvedId,
          input: writeInput,
        })

        assertMutationSuccess(result.documentUpdate, result)
        const document = result.documentUpdate.document
        assertMutationReceipt(document, result, resolvedId)

        let verification: {
          status: string
          content?: string | null
          message?: string
        } | undefined
        if (plan.input.content === "") {
          try {
            const readBack = await readDocument(client, resolvedId)
            if (readBack.document?.content !== "") {
              throw new CliError("Document content is not empty on read-back")
            }
            verification = { status: "verified", content: "" }
          } catch (error) {
            throw new WriteError(
              "The document update was applied, but clearing content could not be verified.",
              {
                effect: "applied",
                data: { document },
                cause: error,
                details: {
                  fields: plan.fields,
                  verification: {
                    status: "unverified",
                    message: error instanceof Error
                      ? error.message
                      : String(error),
                  },
                },
                suggestion:
                  "Inspect the document before retrying. No automatic retry was performed.",
              },
            )
          }
        }

        if (json) {
          printWriteResult({ document }, { fields: plan.fields, verification })
        } else {
          console.log(`✓ Updated document: ${document.title}`)
          console.log(document.url)
        }
      } catch (error) {
        handleError(error, "Failed to update document")
      }
    },
  )
