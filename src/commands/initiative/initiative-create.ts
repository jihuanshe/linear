import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Input, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import {
  INITIATIVE_STATUSES,
  parseInitiativeStatus,
} from "./initiative-status.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { lookupUserId } from "../../utils/linear.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

const CreateInitiative = gql(`
  mutation CreateInitiative($input: InitiativeCreateInput!) {
    initiativeCreate(input: $input) {
      success
      initiative {
        id
        slugId
        name
        url
      }
    }
  }
`)

// Common initiative colors from Linear's palette
const DEFAULT_COLORS = [
  { name: "Red", value: "#EB5757" },
  { name: "Orange", value: "#F2994A" },
  { name: "Yellow", value: "#F2C94C" },
  { name: "Green", value: "#27AE60" },
  { name: "Teal", value: "#0D9488" },
  { name: "Blue", value: "#2F80ED" },
  { name: "Indigo", value: "#5E6AD2" },
  { name: "Purple", value: "#8B5CF6" },
  { name: "Pink", value: "#BB6BD9" },
  { name: "Gray", value: "#6B6F76" },
]

export const createCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  outputModes: ["human", "json"],
})
  .name("create")
  .option("--json", "Output a JSON write result")
  .description("Create a new Linear initiative")
  .option("-n, --name <name:string>", "Initiative name (required)", {
    preserveEmpty: true,
  })
  .option("-d, --description <description:string>", "Initiative description", {
    preserveEmpty: true,
  })
  .option(
    "-s, --status <status:string>",
    "Status: planned, active, completed, proposed, canceled (case-insensitive; non-interactive omission uses server default). Use --status to set explicitly",
    { preserveEmpty: true },
  )
  .option(
    "-o, --owner <owner:string>",
    "Owner (user UUID, username, name, email, 'self', or '@me')",
    { preserveEmpty: true },
  )
  .option(
    "--target-date <targetDate:string>",
    "Target completion date (YYYY-MM-DD)",
    { preserveEmpty: true },
  )
  .option("-c, --color <color:string>", "Color hex code (e.g., #5E6AD2)", {
    preserveEmpty: true,
  })
  .option("--icon <icon:string>", "Icon name", { preserveEmpty: true })
  .option(
    "-i, --interactive",
    "Interactive mode (default if no flags provided)",
  )
  .action(async (options) => {
    setMachineOutput(options.json ?? false)
    try {
      for (
        const [field, value] of Object.entries({
          name: options.name,
          status: options.status,
          owner: options.owner,
          "target-date": options.targetDate,
          color: options.color,
        })
      ) {
        if (value != null && value.trim() === "") {
          throw new ValidationError(`--${field} cannot be empty`)
        }
      }
      if (options.json && options.interactive) {
        throw new ValidationError(
          "--json cannot be combined with --interactive",
        )
      }
      if (
        options.interactive &&
        (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal())
      ) {
        throw new ValidationError("Interactive creation requires a terminal")
      }
      const {
        name: providedName,
        description: providedDescription,
        status: providedStatus,
        owner: providedOwner,
        targetDate: providedTargetDate,
        color: providedColor,
        icon: providedIcon,
        interactive: interactiveFlag,
      } = options

      const client = getGraphQLClient()
      const icon = providedIcon

      let name = providedName
      let description = providedDescription
      let status = providedStatus
      let owner = providedOwner
      let targetDate = providedTargetDate
      let color = providedColor

      // Determine if we should run in interactive mode
      const noFlagsProvided = !name
      const isInteractive = !options.json &&
        (noFlagsProvided || interactiveFlag) &&
        Deno.stdin.isTerminal() && Deno.stdout.isTerminal()

      if (isInteractive) {
        console.log("\nCreate a new initiative\n")

        // Name (required)
        if (!name) {
          name = await Input.prompt({
            message: "Initiative name:",
            minLength: 1,
          })
        }

        // Description (optional)
        if (description == null) {
          description = await Input.prompt({
            message: "Description (optional):",
          })
          if (!description) description = undefined
        }

        // Status selection
        if (!status) {
          const selectedStatus = await Select.prompt({
            message: "Status:",
            options: INITIATIVE_STATUSES,
            default: "Planned",
          })
          status = selectedStatus
        }

        // Owner (optional)
        if (!owner) {
          owner = await Input.prompt({
            message: "Owner (username, email, or @me - press Enter to skip):",
          })
          if (!owner) owner = undefined
        }

        // Target date (optional)
        if (!targetDate) {
          targetDate = await Input.prompt({
            message: "Target date (YYYY-MM-DD - press Enter to skip):",
          })
          if (!targetDate) targetDate = undefined
        }

        // Color selection (optional)
        if (!color) {
          const colorOptions = [
            { name: "Skip (use default)", value: "__skip__" },
            ...DEFAULT_COLORS.map((c) => ({
              name: `${c.name} (${c.value})`,
              value: c.value,
            })),
            { name: "Custom color", value: "__custom__" },
          ]

          const selectedColor = await Select.prompt({
            message: "Color (optional):",
            options: colorOptions,
            default: "__skip__",
          })

          if (selectedColor === "__custom__") {
            color = await Input.prompt({
              message: "Enter hex color (e.g., #FF5733):",
              validate: (value) => {
                if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
                  return "Please enter a valid hex color (e.g., #FF5733)"
                }
                return true
              },
            })
          } else if (selectedColor !== "__skip__") {
            color = selectedColor
          }
        }
      }

      // Validate required fields
      if (!name?.trim()) {
        throw new ValidationError(
          "Initiative name is required. Use --name or -n flag.",
        )
      }

      const apiStatus = status !== undefined
        ? parseInitiativeStatus(status)
        : undefined

      // Validate color format if provided
      if (color != null && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
        throw new ValidationError(
          "Color must be a valid hex code (e.g., #5E6AD2)",
        )
      }

      // Validate target date format if provided
      if (targetDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        throw new ValidationError("Target date must be in YYYY-MM-DD format")
      }

      // Build input
      let ownerId: string | undefined
      if (owner != null) {
        ownerId = await lookupUserId(owner)
        if (!ownerId) {
          throw new NotFoundError("Owner", owner)
        }
      }

      const input = {
        name: name as string,
        ...(description != null && { description }),
        ...(apiStatus != null && { status: apiStatus }),
        ...(ownerId != null && { ownerId }),
        ...(targetDate != null && { targetDate }),
        ...(color != null && { color }),
        ...(icon != null && { icon }),
      }

      const { Spinner } = await import("@std/cli/unstable-spinner")
      const showSpinner = !options.json && shouldShowSpinner()
      const spinner = showSpinner ? new Spinner() : null
      spinner?.start()

      try {
        const result = await client.request(CreateInitiative, { input })

        assertMutationSuccess(
          result?.initiativeCreate,
          result?.initiativeCreate,
        )

        const initiative = result?.initiativeCreate.initiative
        spinner?.stop()
        assertMutationReceipt(initiative, result?.initiativeCreate)
        if (options.json) {
          printWriteResult(initiative)
          return
        }

        console.log(`✓ Created initiative: ${initiative.name}`)
        console.log(`  Slug: ${initiative.slugId}`)
        if (initiative.url) {
          console.log(`  URL: ${initiative.url}`)
        }
      } catch (error) {
        spinner?.stop()
        throw error
      }
    } catch (error) {
      handleError(error, "Failed to create initiative")
    }
  })
