import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Input, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getAllTeams, getTeamKey } from "../../utils/linear.ts"
import { resolveTeam } from "../../utils/issue-read.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  ValidationError,
} from "../../utils/errors.ts"

const CreateIssueLabel = gql(`
  mutation CreateIssueLabel($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel {
        id
        name
        color
        description
        team {
          key
          name
        }
      }
    }
  }
`)

// Common label colors from Linear's palette
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
})
  .name("create")
  .option(
    "--json",
    "Output a JSON write result; the created label is in data.issueLabel",
  )
  .description("Create a new issue label")
  .option("-n, --name <name:string>", "Label name (required)")
  .option(
    "-c, --color <color:string>",
    "Color hex code (e.g., #EB5757)",
  )
  .option("-d, --description <description:string>", "Label description")
  .option(
    "-t, --team <team:string>",
    "Team key or UUID for team-specific label (omit for workspace label)",
  )
  .option(
    "-i, --interactive",
    "Interactive mode (default if no flags provided)",
  )
  .action(async (options) => {
    try {
      if (options.json && options.interactive) {
        throw new ValidationError(
          "--json cannot be combined with --interactive",
        )
      }
      const {
        name: providedName,
        color: providedColor,
        description: providedDescription,
        team: providedTeam,
        interactive: interactiveFlag,
      } = options

      const client = getGraphQLClient()

      let name = providedName
      let color = providedColor
      let description = providedDescription
      let teamId: string | undefined

      // Determine if we should run in interactive mode
      const noFlagsProvided = !name
      const isInteractive = !options.json &&
        (noFlagsProvided || interactiveFlag) &&
        Deno.stdout.isTerminal()

      if (isInteractive) {
        console.log("\nCreate a new label\n")

        // Name (required)
        if (!name) {
          name = await Input.prompt({
            message: "Label name:",
            minLength: 1,
          })
        }

        // Color selection
        if (!color) {
          const colorOptions = [
            ...DEFAULT_COLORS.map((c) => ({
              name: `${c.name} (${c.value})`,
              value: c.value,
            })),
            { name: "Custom color", value: "custom" },
          ]

          const selectedColor = await Select.prompt({
            message: "Color:",
            options: colorOptions,
            default: DEFAULT_COLORS[6].value, // Indigo
          })

          if (selectedColor === "custom") {
            color = await Input.prompt({
              message: "Enter hex color (e.g., #FF5733):",
              validate: (value) => {
                if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
                  return "Please enter a valid hex color (e.g., #FF5733)"
                }
                return true
              },
            })
          } else {
            color = selectedColor
          }
        }

        // Description (optional)
        if (!description) {
          description = await Input.prompt({
            message: "Description (optional):",
          })
          if (!description) description = undefined
        }

        // Team selection (optional)
        if (providedTeam === undefined) {
          const allTeams = await getAllTeams()
          const teamOptions = [
            { name: "Workspace (shared by all teams)", value: "__workspace__" },
            ...allTeams.map((t) => ({
              name: `${t.name} (${t.key})`,
              value: t.id,
            })),
          ]

          // Try to get default team from config
          const defaultTeamKey = getTeamKey()
          const defaultTeam = allTeams.find((team) =>
            team.key === defaultTeamKey
          )?.id
          const defaultIndex = defaultTeam
            ? teamOptions.findIndex((t) => t.value === defaultTeam)
            : 0

          const selectedTeam = await Select.prompt({
            message: "Team:",
            options: teamOptions,
            default: defaultIndex >= 0
              ? teamOptions[defaultIndex].value
              : "__workspace__",
          })

          teamId = selectedTeam === "__workspace__" ? undefined : selectedTeam
        }
      }

      // Validate required fields
      if (!name?.trim()) {
        throw new ValidationError("Label name is required", {
          suggestion: "Use --name or -n flag to specify a label name.",
        })
      }

      // Validate color format if provided
      if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
        throw new ValidationError(
          "Color must be a valid hex code (e.g., #EB5757)",
        )
      }

      // Default color if not provided
      if (!color) {
        color = DEFAULT_COLORS[6].value // Indigo
      }

      // Build input
      if (providedTeam != null) {
        teamId = (await resolveTeam(providedTeam)).id
      }

      const input = {
        name,
        color,
        ...(description && { description }),
        ...(teamId && { teamId }),
      }

      const { Spinner } = await import("@std/cli/unstable-spinner")
      const showSpinner = !options.json && shouldShowSpinner()
      const spinner = showSpinner ? new Spinner() : null
      spinner?.start()

      try {
        const result = await client.request(CreateIssueLabel, { input })

        assertMutationSuccess(
          result?.issueLabelCreate,
          result?.issueLabelCreate,
        )

        const label = result?.issueLabelCreate.issueLabel
        spinner?.stop()
        assertMutationReceipt(label, result?.issueLabelCreate)
        if (options.json) {
          printWriteResult({ issueLabel: label })
          return
        }

        console.log(`✓ Created label: ${label.name}`)
        console.log(`  Color: ${label.color}`)
        if (label.description) {
          console.log(`  Description: ${label.description}`)
        }
        console.log(
          `  Scope: ${
            label.team?.name
              ? `${label.team.name} (${label.team.key})`
              : "Workspace"
          }`,
        )
      } catch (error) {
        spinner?.stop()
        throw error
      }
    } catch (error) {
      handleError(error, "Failed to create label")
    }
  })
