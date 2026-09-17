import { resolveInitiativeId } from "../initiative/initiative-resolve.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Input, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { InitiativeUpdateCreateInput } from "../../__codegen__/graphql.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { getEditor, openEditor } from "../../utils/editor.ts"
import { readTextSource } from "../../utils/text-source.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"

const HEALTH_VALUES = ["onTrack", "atRisk", "offTrack"] as const
type HealthValue = (typeof HEALTH_VALUES)[number]

export const createCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("create")
  .option(
    "--json",
    "Output a JSON write result; the created update is in data.initiativeUpdate",
  )
  .description("Create a new status update for an initiative")
  .alias("c")
  .arguments("<initiativeId:string>")
  .option("--body <body:string>", "Update content (markdown)", {
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
    "Health status (onTrack, atRisk, offTrack)",
  )
  .option("-i, --interactive", "Interactive mode with prompts")
  .action(
    async (
      { body, bodyFile, health, interactive, json, edit },
      initiativeId,
    ) => {
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

        // Resolve initiative ID
        const resolvedId = await resolveInitiativeId(client, initiativeId)
        if (!resolvedId) {
          throw new NotFoundError("Initiative", initiativeId)
        }

        // Get initiative name for display
        const initiativeQuery = gql(`
        query GetInitiativeNameForStatusUpdate($id: String!) {
          initiative(id: $id) {
            name
            slugId
          }
        }
      `)
        let initiativeName = initiativeId
        try {
          const result = await client.request(initiativeQuery, {
            id: resolvedId,
          })
          if (result.initiative?.name) {
            initiativeName = result.initiative.name
          }
        } catch {
          // Use provided ID as fallback
        }

        // Interactive mode
        if (interactive) {
          const result = await promptInteractiveCreate(initiativeName)

          await createInitiativeUpdate(client, {
            initiativeId: resolvedId,
            body: result.body,
            health: result.health,
          })
          return
        }

        if (edit) {
          finalBody = await openEditor(finalBody)
        } else if (finalBody == null && !Deno.stdin.isTerminal()) {
          finalBody = await readTextSource("body", undefined, "-") || undefined
        }

        // Validate health value if provided
        let validatedHealth: HealthValue | undefined
        if (health !== undefined) {
          if (!HEALTH_VALUES.includes(health as HealthValue)) {
            throw new ValidationError(`Invalid health value: ${health}`, {
              suggestion: `Valid values: ${HEALTH_VALUES.join(", ")}`,
            })
          }
          validatedHealth = health as HealthValue
        }

        await createInitiativeUpdate(client, {
          initiativeId: resolvedId,
          body: finalBody,
          health: validatedHealth,
        }, json)
      } catch (error) {
        handleError(error, "Failed to create initiative status update")
      }
    },
  )

async function promptInteractiveCreate(initiativeName: string): Promise<{
  body?: string
  health?: HealthValue
}> {
  console.log(`\nCreating status update for: ${initiativeName}\n`)

  // Prompt for health status
  const healthChoice = await Select.prompt({
    message: "Health status",
    options: [
      { name: "Skip (no change)", value: "skip" },
      { name: "On Track", value: "onTrack" },
      { name: "At Risk", value: "atRisk" },
      { name: "Off Track", value: "offTrack" },
    ],
    default: "skip",
  })

  const health = healthChoice === "skip"
    ? undefined
    : (healthChoice as HealthValue)

  // Prompt for body entry method
  const editorName = await getEditor()
  const editorDisplayName = editorName ? editorName.split("/").pop() : null

  const contentMethod = await Select.prompt({
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

  if (contentMethod === "inline") {
    const inlineContent = await Input.prompt({
      message: "Content (markdown)",
      default: "",
    })
    body = inlineContent
  } else if (contentMethod === "editor" && editorDisplayName) {
    console.log(`Opening ${editorDisplayName}...`)
    body = await openEditor()
    if (body) {
      console.log(`Content entered (${body.length} characters)`)
    }
  } else if (contentMethod === "file") {
    const filePath = await Input.prompt({
      message: "File path",
    })
    body = await readTextSource("body", undefined, filePath)
  }

  return { body, health }
}

async function createInitiativeUpdate(
  client: ReturnType<typeof getGraphQLClient>,
  options: {
    initiativeId: string
    body?: string
    health?: HealthValue
  },
  json = false,
): Promise<void> {
  const { initiativeId, body, health } = options
  if (!body?.trim() && !health) {
    throw new ValidationError("Provide update content or --health")
  }

  const { Spinner } = await import("@std/cli/unstable-spinner")
  const showSpinner = !json && shouldShowSpinner()
  const spinner = showSpinner ? new Spinner() : null
  spinner?.start()

  const createMutation = gql(`
    mutation CreateInitiativeUpdate($input: InitiativeUpdateCreateInput!) {
      initiativeUpdateCreate(input: $input) {
        success
        initiativeUpdate {
          id
          body
          health
          url
          createdAt
          initiative {
            name
            slugId
          }
        }
      }
    }
  `)

  // Build input - only include fields that are provided
  const input: InitiativeUpdateCreateInput = {
    initiativeId,
  }

  if (body != null) {
    input.body = body
  }

  if (health != null) {
    input.health = health
  }

  const result = await client.request(createMutation, { input })

  spinner?.stop()

  assertMutationSuccess(
    result?.initiativeUpdateCreate,
    result?.initiativeUpdateCreate,
  )

  const update = result?.initiativeUpdateCreate.initiativeUpdate
  assertMutationReceipt(update, result?.initiativeUpdateCreate)
  if (json) {
    printWriteResult({ initiativeUpdate: update })
    return
  }

  const initiativeName = update.initiative?.name || "Unknown"
  console.log(`Created status update for: ${initiativeName}`)
  if (update.health) {
    console.log(`Health: ${update.health}`)
  }
  if (update.url) {
    console.log(update.url)
  }
}
