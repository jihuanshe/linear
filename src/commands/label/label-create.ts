import { Command, EnumType } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Input, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getAllTeams, getTeamKey } from "../../utils/linear.ts"
import { resolveTeam } from "../../utils/issue-read.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { readLabelGroup } from "./label-read.ts"
import {
  assertMutationReceipt,
  assertMutationReferences,
  assertMutationSuccess,
  handleError,
  ValidationError,
  WriteError,
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
        isGroup
        groupType
        parent { id name }
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
  .description("Create an issue label or label group")
  .type("groupType", new EnumType(["singleSelect", "multiSelect"] as const))
  .option("--group", "Create a label group")
  .option(
    "--group-type <type:groupType>",
    "Selection mode; requires --group (default: singleSelect)",
  )
  .option(
    "--parent <uuid:string>",
    "Create the label in this group UUID; cannot be combined with --group",
    { preserveEmpty: true },
  )
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
      if (options.groupType != null && !options.group) {
        throw new ValidationError("--group-type requires --group")
      }
      if (options.group && options.parent != null) {
        throw new ValidationError("A label group cannot have a parent group")
      }
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

      const parent = options.parent == null
        ? undefined
        : await readLabelGroup(client, options.parent)
      const input = {
        name,
        color,
        ...(description && { description }),
        ...(teamId && { teamId }),
        ...(options.group &&
          { isGroup: true, groupType: options.groupType ?? "singleSelect" }),
        ...(parent && { parentId: parent.id }),
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
        if (parent) {
          assertMutationReferences(label, result.issueLabelCreate, {
            parent: parent.id,
          })
        }
        if (
          options.group &&
          (!label.isGroup ||
            (label.groupType === null ? "singleSelect" : label.groupType) !==
              input.groupType)
        ) {
          throw new WriteError(
            "Label creation succeeded but the receipt did not match the requested group type",
            {
              effect: "applied",
              data: { issueLabel: label },
              suggestion:
                "Read the label before continuing; do not repeat the mutation.",
            },
          )
        }
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
