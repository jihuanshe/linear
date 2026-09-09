import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { withMarkdownHint } from "../../utils/markdown-help.ts"
import { Input, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { DocumentCreateInput } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { resolveProjectId } from "../../utils/linear.ts"
import { getEditor, openEditor } from "../../utils/editor.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  CliError,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

/**
 * Read all piped content before creating the document.
 */
async function readContentFromStdin(): Promise<string | undefined> {
  // Check if stdin has data (not a TTY)
  if (Deno.stdin.isTerminal()) {
    return undefined
  }

  const content = await new Response(Deno.stdin.readable).text()
  return content.length > 0 ? content : undefined
}

export const createCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  outputModes: ["human", "json"],
})
  .name("create")
  .option("--json", "Output a JSON write result")
  .description(withMarkdownHint("Create a new document"))
  .alias("c")
  .option("-t, --title <title:string>", "Document title (required)")
  .option("-c, --content <content:string>", "Markdown content (inline)")
  .option("-f, --content-file <path:string>", "Read content from file")
  .option(
    "--project <project:string>",
    "Attach to project (UUID, slug ID, or name)",
  )
  .option("--issue <issue:string>", "Attach to issue (identifier like TC-123)")
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
    }) => {
      setMachineOutput(json ?? false)
      try {
        if (json && interactive) {
          throw new ValidationError(
            "--json cannot be combined with --interactive",
          )
        }
        if (content !== undefined && contentFile !== undefined) {
          throw new ValidationError("Use either --content or --content-file")
        }
        const client = getGraphQLClient()

        // Determine if we should use interactive mode
        let useInteractive = !json && interactive && Deno.stdout.isTerminal()

        // If no title and not interactive, check if we should enter interactive mode
        const noFlagsProvided = !title && !content && !contentFile &&
          !project &&
          !issue && !icon
        if (!json && noFlagsProvided && Deno.stdout.isTerminal()) {
          useInteractive = true
        }

        // Interactive mode
        if (useInteractive) {
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

        // Resolve content from various sources
        let finalContent: string | undefined

        if (content !== undefined) {
          // Content provided inline via --content
          finalContent = content
        } else if (contentFile) {
          // Content from file via --content-file
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
        } else if (!Deno.stdin.isTerminal()) {
          // Try reading from stdin if piped
          const stdinContent = await readContentFromStdin()
          if (stdinContent) {
            finalContent = stdinContent
          }
        } else if (!json && Deno.stdout.isTerminal()) {
          // No content provided, open editor
          console.log("Opening editor for document content...")
          finalContent = await openEditor()
          if (!finalContent) {
            console.log(
              "No content entered. Creating document without content.",
            )
          }
        }

        // Resolve project ID if provided
        let projectId: string | undefined
        if (project) {
          projectId = await resolveProjectId(project)
        }

        // Resolve issue ID if provided
        let issueId: string | undefined
        if (issue) {
          issueId = await resolveIssueId(client, issue)
          if (!issueId) {
            throw new NotFoundError("Issue", issue, {
              suggestion: "Provide a valid issue identifier (e.g., TC-123).",
            })
          }
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
    content = inlineContent.trim() || undefined
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
    try {
      content = await Deno.readTextFile(filePath)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new NotFoundError("File", filePath)
      }
      throw new CliError(
        `Failed to read file: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
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
      message: "Issue identifier (e.g., TC-123)",
    })
    const client = getGraphQLClient()
    issueId = await resolveIssueId(client, issueInput)
    if (!issueId) {
      throw new NotFoundError("Issue", issueInput, {
        suggestion: "Provide a valid issue identifier (e.g., TC-123).",
      })
    }
  }

  return {
    title,
    content,
    icon: icon.trim() || undefined,
    projectId,
    issueId,
  }
}

async function resolveIssueId(
  client: ReturnType<typeof getGraphQLClient>,
  issueIdentifier: string,
): Promise<string | undefined> {
  const issueQuery = gql(`
    query GetIssueForDocument($id: String!) {
      issue(id: $id) {
        id
        identifier
      }
    }
  `)

  try {
    const result = await client.request(issueQuery, { id: issueIdentifier })
    if (result.issue) {
      return result.issue.id
    }
  } catch {
    // Issue not found
  }

  return undefined
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
    printWriteResult(document)
    return
  }

  console.log(`✓ Created document: ${document.title}`)
  console.log(document.url)
}
