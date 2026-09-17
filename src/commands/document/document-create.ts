import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { withMarkdownHint } from "../../utils/markdown-help.ts"
import { Input, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { DocumentCreateInput } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import {
  getIssueReference,
  requireIssueId,
  resolveProjectId,
} from "../../utils/linear.ts"
import { getEditor, openEditor } from "../../utils/editor.ts"
import { readTextSource } from "../../utils/text-source.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  ValidationError,
} from "../../utils/errors.ts"

export const createCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("create")
  .option(
    "--json",
    "Output a JSON write result; the created document is in data.document",
  )
  .description(withMarkdownHint("Create a new document"))
  .alias("c")
  .option("-t, --title <title:string>", "Document title (required)")
  .option("-c, --content <content:string>", "Markdown content (inline)", {
    preserveEmpty: true,
  })
  .option(
    "-f, --content-file <path:string>",
    "Read UTF-8 content from a file (- for stdin)",
    {
      preserveEmpty: true,
    },
  )
  .option(
    "--edit",
    "Open an editor, optionally seeded by --content or --content-file",
  )
  .option(
    "--project <project:string>",
    "Attach to project (UUID, slug ID, or name; exactly one parent is required)",
  )
  .option(
    "--issue <issue:string>",
    "Attach to issue (UUID, identifier, number in the configured team, or Linear URL; exactly one parent is required)",
    { preserveEmpty: true },
  )
  .option("--icon <icon:string>", "Document icon (emoji)")
  .option("-i, --interactive", "Interactive mode with prompts")
  .action(
    async ({
      title,
      content,
      contentFile,
      project,
      issue,
      icon,
      interactive,
      json,
      edit,
    }) => {
      try {
        if (json && (interactive || edit)) {
          throw new ValidationError(
            "--json cannot be combined with --interactive or --edit",
          )
        }
        if (interactive && (content != null || contentFile != null || edit)) {
          throw new ValidationError(
            "--interactive cannot be combined with content options",
          )
        }
        if (
          interactive && (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal())
        ) {
          throw new ValidationError("Interactive creation requires a terminal")
        }
        let finalContent = await readTextSource("content", content, contentFile)
        const client = getGraphQLClient()

        // Interactive mode
        if (interactive) {
          const result = await promptInteractiveCreate()

          if (!result.title) {
            throw new ValidationError("Title is required")
          }

          const input: DocumentCreateInput = {
            title: result.title,
            ...(result.content != null ? { content: result.content } : {}),
            ...(result.icon != null ? { icon: result.icon } : {}),
            ...(result.projectId != null
              ? { projectId: result.projectId }
              : {}),
            ...(result.issueId != null ? { issueId: result.issueId } : {}),
          }

          await createDocument(client, input)
          return
        }

        // Non-interactive mode requires title
        if (!title?.trim()) {
          throw new ValidationError("Title is required", {
            suggestion: "Use --title or run with -i for interactive mode.",
          })
        }
        if ((project == null) === (issue == null)) {
          throw new ValidationError(
            "Exactly one document parent must be provided",
            { suggestion: "Use either --project or --issue." },
          )
        }

        if (edit) {
          finalContent = await openEditor(finalContent)
        } else if (finalContent == null && !Deno.stdin.isTerminal()) {
          finalContent = await readTextSource("content", undefined, "-") ||
            undefined
        }

        // Resolve project ID if provided
        let projectId: string | undefined
        if (project) {
          projectId = await resolveProjectId(project)
        }

        // Resolve the Issue reference to its stable UUID if provided.
        let issueId: string | undefined
        if (issue != null) {
          const reference = await getIssueReference(issue)
          if (!reference) {
            throw new ValidationError(`Invalid issue reference: ${issue}`)
          }
          issueId = await requireIssueId(reference)
        }

        // Build input
        const input: DocumentCreateInput = {
          title,
          ...(finalContent != null ? { content: finalContent } : {}),
          ...(icon != null ? { icon } : {}),
          ...(projectId != null ? { projectId } : {}),
          ...(issueId != null ? { issueId } : {}),
        }

        await createDocument(client, input, json)
      } catch (error) {
        handleError(error, "Failed to create document")
      }
    },
  )

async function promptInteractiveCreate(): Promise<{
  title?: string
  content?: string
  icon?: string
  projectId?: string
  issueId?: string
}> {
  // Prompt for title
  const title = await Input.prompt({
    message: "Document title",
    minLength: 1,
  })

  // Prompt for description entry method
  const editorName = await getEditor()
  const editorDisplayName = editorName ? editorName.split("/").pop() : null

  const contentMethod = await Select.prompt({
    message: "How would you like to enter content?",
    options: [
      { name: "Skip (no content)", value: "skip" },
      { name: "Enter inline", value: "inline" },
      ...(editorDisplayName
        ? [{ name: `Open ${editorDisplayName}`, value: "editor" }]
        : []),
      { name: "Read from file", value: "file" },
    ],
    default: "skip",
  })

  let content: string | undefined

  if (contentMethod === "inline") {
    const inlineContent = await Input.prompt({
      message: "Content (markdown)",
      default: "",
    })
    content = inlineContent
  } else if (contentMethod === "editor" && editorDisplayName) {
    console.log(`Opening ${editorDisplayName}...`)
    content = await openEditor()
    if (content) {
      console.log(`Content entered (${content.length} characters)`)
    }
  } else if (contentMethod === "file") {
    const filePath = await Input.prompt({
      message: "File path",
    })
    content = await readTextSource("content", undefined, filePath)
  }

  // Prompt for icon
  const icon = await Input.prompt({
    message: "Icon (emoji, leave blank for none)",
    default: "",
  })

  // Ask about attachment
  const attachTo = await Select.prompt({
    message: "Attach document to",
    options: [
      { name: "Nothing (workspace document)", value: "none" },
      { name: "Project", value: "project" },
      { name: "Issue", value: "issue" },
    ],
    default: "none",
  })

  let projectId: string | undefined
  let issueId: string | undefined

  if (attachTo === "project") {
    const projectInput = await Input.prompt({
      message: "Project (UUID, slug ID, or name)",
    })
    projectId = await resolveProjectId(projectInput)
  } else if (attachTo === "issue") {
    const issueInput = await Input.prompt({
      message: "Issue (UUID, identifier, or Linear Issue URL)",
    })
    const reference = await getIssueReference(issueInput)
    if (!reference) {
      throw new ValidationError(`Invalid issue reference: ${issueInput}`)
    }
    issueId = await requireIssueId(reference)
  }

  return {
    title,
    content,
    icon: icon.trim() || undefined,
    projectId,
    issueId,
  }
}

async function createDocument(
  client: ReturnType<typeof getGraphQLClient>,
  input: DocumentCreateInput,
  json = false,
): Promise<void> {
  const createMutation = gql(`
    mutation CreateDocument($input: DocumentCreateInput!) {
      documentCreate(input: $input) {
        success
        document {
          id
          slugId
          title
          url
        }
      }
    }
  `)

  const result = await client.request(createMutation, { input })

  assertMutationSuccess(result?.documentCreate, result?.documentCreate)

  const document = result?.documentCreate.document
  assertMutationReceipt(document, result?.documentCreate)
  if (json) {
    printWriteResult({ document })
    return
  }

  console.log(`✓ Created document: ${document.title}`)
  console.log(document.url)
}
