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
import { resolveInitiativeId } from "../initiative/initiative-resolve.ts"
import {
  assertMutationReferences,
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
    "Output {ok, effect, data}; the created document is in data.document, its UUID in data.document.id",
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
    "Attach to project (UUID, slug ID, name, or Linear URL; exactly one parent is required)",
  )
  .option(
    "--initiative <initiative:string>",
    "Attach to initiative (UUID, slug ID, name, or Linear URL; exactly one parent is required)",
    { preserveEmpty: true },
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
      initiative,
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
            ...(result.initiativeId != null
              ? { initiativeId: result.initiativeId }
              : {}),
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
        if (
          [project, issue, initiative].filter((parent) => parent != null)
            .length !== 1
        ) {
          throw new ValidationError(
            "Exactly one document parent must be provided",
            { suggestion: "Use one of --project, --issue, or --initiative." },
          )
        }
        if (initiative != null && !initiative.trim()) {
          throw new ValidationError("--initiative cannot be empty")
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

        const initiativeId = initiative != null
          ? await resolveInitiativeId(client, initiative)
          : undefined

        // Build input
        const input: DocumentCreateInput = {
          title,
          ...(finalContent != null ? { content: finalContent } : {}),
          ...(icon != null ? { icon } : {}),
          ...(projectId != null ? { projectId } : {}),
          ...(issueId != null ? { issueId } : {}),
          ...(initiativeId != null ? { initiativeId } : {}),
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
  initiativeId?: string
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
      { name: "Initiative", value: "initiative" },
    ],
    default: "none",
  })

  let projectId: string | undefined
  let issueId: string | undefined
  let initiativeId: string | undefined

  if (attachTo === "project") {
    const projectInput = await Input.prompt({
      message: "Project (UUID, slug ID, name, or Linear URL)",
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
  } else if (attachTo === "initiative") {
    const initiativeInput = await Input.prompt({
      message: "Initiative (UUID, slug ID, name, or Linear URL)",
    })
    initiativeId = await resolveInitiativeId(
      getGraphQLClient(),
      initiativeInput,
    )
  }

  return {
    title,
    content,
    icon: icon.trim() || undefined,
    projectId,
    issueId,
    initiativeId,
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
          project {
            id
          }
          issue {
            id
          }
          initiative {
            id
          }
        }
      }
    }
  `)

  const result = await client.request(createMutation, { input })

  assertMutationSuccess(result?.documentCreate, result?.documentCreate)

  const document = result?.documentCreate.document
  // A document must land on the requested parent, like comments and attachments.
  assertMutationReferences(document, result?.documentCreate, {
    ...(input.projectId != null ? { project: input.projectId } : {}),
    ...(input.issueId != null ? { issue: input.issueId } : {}),
    ...(input.initiativeId != null ? { initiative: input.initiativeId } : {}),
  })
  if (json) {
    printWriteResult({ document })
    return
  }

  console.log(`✓ Created document: ${document.title}`)
  console.log(document.url)
}
