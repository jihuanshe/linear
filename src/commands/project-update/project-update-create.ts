import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Input, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getEditor, openEditor } from "../../utils/editor.ts"
import { readTextSource } from "../../utils/text-source.ts"
import { resolveProjectId } from "../../utils/linear.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  ValidationError,
} from "../../utils/errors.ts"

type ProjectUpdateHealth = "onTrack" | "atRisk" | "offTrack"

const CreateProjectUpdate = gql(`
  mutation CreateProjectUpdate($input: ProjectUpdateCreateInput!) {
    projectUpdateCreate(input: $input) {
      success
      projectUpdate {
        id
        body
        health
        url
        createdAt
        project {
          name
          slugId
        }
      }
    }
  }
`)

export const createCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("create")
  .option(
    "--json",
    "Output a JSON write result; the created update is in data.projectUpdate",
  )
  .description("Create a new status update for a project")
  .alias("c")
  .arguments("<projectId:string>")
  .option("--body <body:string>", "Update content (inline)", {
    preserveEmpty: true,
  })
  .option(
    "--body-file <path:string>",
    "Read UTF-8 content from a file (- for stdin)",
    { preserveEmpty: true },
  )
  .option(
    "--edit",
    "Open an editor, optionally seeded by --body or --body-file",
  )
  .option(
    "--health <health:string>",
    "Project health status (onTrack, atRisk, offTrack)",
  )
  .option("-i, --interactive", "Interactive mode with prompts")
  .action(
    async (
      { body, bodyFile, health, interactive, json, edit },
      projectId,
    ) => {
      const { Spinner } = await import("@std/cli/unstable-spinner")

      try {
        if (json && (interactive || edit)) {
          throw new ValidationError(
            "--json cannot be combined with --interactive or --edit",
          )
        }
        if (
          interactive &&
          (body != null || bodyFile != null || edit || health != null)
        ) {
          throw new ValidationError(
            "--interactive cannot be combined with body or health options",
          )
        }
        if (
          interactive && (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal())
        ) {
          throw new ValidationError("Interactive creation requires a terminal")
        }
        let finalBody = await readTextSource("body", body, bodyFile)
        const client = getGraphQLClient()
        // Resolve project ID
        const resolvedProjectId = await resolveProjectId(projectId)

        // Interactive mode
        if (interactive) {
          const result = await promptInteractiveCreate()

          const input: {
            projectId: string
            body?: string
            health?: ProjectUpdateHealth
          } = {
            projectId: resolvedProjectId,
          }

          if (result.body != null) {
            input.body = result.body
          }

          if (result.health) {
            input.health = result.health
          }

          await createProjectUpdate(client, input)
          return
        }

        if (edit) {
          finalBody = await openEditor(finalBody)
        } else if (finalBody == null && !Deno.stdin.isTerminal()) {
          finalBody = await readTextSource("body", undefined, "-") || undefined
        }

        // Validate health value if provided
        let validatedHealth: ProjectUpdateHealth | undefined
        if (health !== undefined) {
          const validHealthValues = ["onTrack", "atRisk", "offTrack"]
          if (!validHealthValues.includes(health)) {
            throw new ValidationError(`Invalid health value: ${health}`, {
              suggestion: `Must be one of: ${validHealthValues.join(", ")}`,
            })
          }
          validatedHealth = health as ProjectUpdateHealth
        }

        // Build input
        const input: {
          projectId: string
          body?: string
          health?: ProjectUpdateHealth
        } = {
          projectId: resolvedProjectId,
        }

        if (finalBody != null) {
          input.body = finalBody
        }

        if (validatedHealth) {
          input.health = validatedHealth
        }

        const showSpinner = !json && shouldShowSpinner()
        const spinner = showSpinner ? new Spinner() : null
        spinner?.start()

        try {
          await createProjectUpdate(client, input, json)
        } finally {
          spinner?.stop()
        }
      } catch (error) {
        handleError(error, "Failed to create project update")
      }
    },
  )

async function promptInteractiveCreate(): Promise<{
  body?: string
  health?: ProjectUpdateHealth
}> {
  // Prompt for health status
  const health = await Select.prompt({
    message: "Project health status",
    options: [
      { name: "On Track", value: "onTrack" },
      { name: "At Risk", value: "atRisk" },
      { name: "Off Track", value: "offTrack" },
      { name: "No change", value: "" },
    ],
    default: "",
  })

  // Prompt for body entry method
  const editorName = await getEditor()
  const editorDisplayName = editorName ? editorName.split("/").pop() : null

  const bodyMethod = await Select.prompt({
    message: "How would you like to enter the update content?",
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

  let body: string | undefined

  if (bodyMethod === "inline") {
    const inlineContent = await Input.prompt({
      message: "Update content (markdown)",
      default: "",
    })
    body = inlineContent
  } else if (bodyMethod === "editor" && editorDisplayName) {
    console.log(`Opening ${editorDisplayName}...`)
    body = await openEditor()
    if (body) {
      console.log(`Content entered (${body.length} characters)`)
    }
  } else if (bodyMethod === "file") {
    const filePath = await Input.prompt({
      message: "File path",
    })
    body = await readTextSource("body", undefined, filePath)
  }

  return {
    body,
    health: health ? (health as ProjectUpdateHealth) : undefined,
  }
}

async function createProjectUpdate(
  client: ReturnType<typeof getGraphQLClient>,
  input: {
    projectId: string
    body?: string
    health?: ProjectUpdateHealth
  },
  json = false,
): Promise<void> {
  try {
    if (!input.body?.trim() && !input.health) {
      throw new ValidationError("Provide update content or --health")
    }
    const result = await client.request(CreateProjectUpdate, { input })

    assertMutationSuccess(
      result?.projectUpdateCreate,
      result?.projectUpdateCreate,
    )

    const projectUpdate = result?.projectUpdateCreate.projectUpdate
    assertMutationReceipt(projectUpdate, result?.projectUpdateCreate)
    if (json) {
      printWriteResult({ projectUpdate })
      return
    }

    const projectName = projectUpdate.project?.name || "Unknown project"
    console.log(`Created status update for: ${projectName}`)
    if (projectUpdate.health) {
      console.log(`Health: ${projectUpdate.health}`)
    }
    console.log(projectUpdate.url)
  } catch (error) {
    handleError(error, "Failed to create project update")
  }
}
