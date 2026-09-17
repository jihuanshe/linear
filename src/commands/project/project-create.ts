import { Command } from "@cliffy/command"
import { readTextSource } from "../../utils/text-source.ts"
import { getProjectStatuses, resolveProjectStatusId } from "./project-status.ts"
import { withUsageMetadata } from "../usage.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { Input, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { ProjectCreateInput } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { resolveTeam } from "../../utils/issue-read.ts"
import { priorityType } from "../../utils/priority.ts"
import {
  getAllTeams,
  getTeamKey,
  lookupProjectLabelId,
  lookupUserId,
} from "../../utils/linear.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  resolveProjectDescription,
} from "./project-description.ts"

const CreateProject = gql(`
  mutation CreateProject($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project {
        id
        slugId
        name
        url
      }
    }
  }
`)

export const createCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("create")
  .type("priority", priorityType)
  .description(
    "Create a new Linear project; link it separately with initiative add-project",
  )
  .option("-n, --name <name:string>", "Project name (required)", {
    preserveEmpty: true,
  })
  .option(
    "-d, --description <description:string>",
    `Project description (max ${PROJECT_DESCRIPTION_MAX_LENGTH} characters, enforced by Linear's API)`,
    { preserveEmpty: true },
  )
  .option(
    "-f, --description-file <path:string>",
    `Read UTF-8 project description from a file (- for stdin; still subject to the ${PROJECT_DESCRIPTION_MAX_LENGTH}-character API limit)`,
    { preserveEmpty: true },
  )
  .option("--content <content:string>", "Project overview markdown", {
    preserveEmpty: true,
  })
  .option(
    "--content-file <path:string>",
    "Read UTF-8 project overview markdown from a file (- for stdin)",
    { preserveEmpty: true },
  )
  .option(
    "-t, --team <team:string>",
    "Team UUID or key (repeatable; uses the configured default team when omitted)",
    { collect: true, preserveEmpty: true },
  )
  .option(
    "-l, --lead <lead:string>",
    "Project lead (user UUID, username, name, email, 'self', or '@me')",
    { preserveEmpty: true },
  )
  .option(
    "-s, --status <status:string>",
    "Status UUID or type (planned, started, paused, completed, canceled, backlog)",
    { preserveEmpty: true },
  )
  .option("--start-date <date:string>", "Start date (YYYY-MM-DD)", {
    preserveEmpty: true,
  })
  .option(
    "--target-date <date:string>",
    "Target completion date (YYYY-MM-DD)",
    { preserveEmpty: true },
  )
  .option(
    "--priority <priority:priority>",
    "Priority (0/none, 1/urgent, 2/high, 3/medium, 4/low; names are case-insensitive)",
    { preserveEmpty: true },
  )
  .option(
    "--label <label:string>",
    "Project label UUID or exact name. May be repeated.",
    { collect: true, preserveEmpty: true },
  )
  .option(
    "--member <user:string>",
    "Project member (user UUID, username, name, email, 'self', or '@me'). May be repeated.",
    { collect: true, preserveEmpty: true },
  )
  .option("--icon <icon:string>", "Project icon", { preserveEmpty: true })
  .option("--color <color:string>", "Project color as a HEX string", {
    preserveEmpty: true,
  })
  .option(
    "-i, --interactive",
    "Interactive mode (default if no flags provided)",
  )
  .option(
    "-j, --json",
    "Output a JSON write result; the created project is in data.project",
  )
  .action(
    async (options) => {
      try {
        if (options.interactive && options.json) {
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
        for (
          const [field, value] of Object.entries({
            name: options.name,
            lead: options.lead,
            status: options.status,
            "start-date": options.startDate,
            "target-date": options.targetDate,
          })
        ) {
          if (value != null && value.trim() === "") {
            throw new ValidationError(`--${field} cannot be empty`)
          }
        }
        for (
          const [field, values] of Object.entries({
            team: options.team,
            label: options.label,
            member: options.member,
          })
        ) {
          if (values?.some((value) => value.trim() === "")) {
            throw new ValidationError(`--${field} cannot be empty`)
          }
        }
        const {
          name: providedName,
          description: providedDescription,
          descriptionFile: providedDescriptionFile,
          content: providedContent,
          contentFile: providedContentFile,
          team: providedTeams,
          lead: providedLead,
          status: providedStatus,
          startDate: providedStartDate,
          targetDate: providedTargetDate,
          priority,
          label: providedLabels,
          member: providedMembers,
          icon: providedIcon,
          color: providedColor,
          interactive: interactiveFlag,
          json: jsonOutput,
        } = options

        const content = await readTextSource(
          "content",
          providedContent,
          providedContentFile,
        )
        const client = getGraphQLClient()

        let name = providedName
        let description = await resolveProjectDescription(
          providedDescription,
          providedDescriptionFile,
        )
        let teams = providedTeams || []
        let teamIds: string[] | undefined
        let lead = providedLead
        let status = providedStatus
        let startDate = providedStartDate
        let targetDate = providedTargetDate
        const labels = providedLabels || []
        const members = providedMembers || []

        // Determine if we should run in interactive mode
        const noFlagsProvided = !name && teams.length === 0
        const isInteractive = !jsonOutput &&
          (noFlagsProvided || interactiveFlag) &&
          Deno.stdin.isTerminal() && Deno.stdout.isTerminal()

        if (isInteractive) {
          console.log("\nCreate a new project\n")

          // Name (required)
          if (!name) {
            name = await Input.prompt({
              message: "Project name:",
              minLength: 1,
            })
          }

          if (description == null) {
            description = await Input.prompt({
              message: "Description (optional):",
            })
          }

          // Team selection (required)
          if (teams.length === 0) {
            const allTeams = await getAllTeams()
            const teamOptions = allTeams.map((t) => ({
              name: `${t.name} (${t.key})`,
              value: t.id,
            }))

            // Try to get default team from config
            const defaultTeam = getTeamKey()
            const defaultTeamId = allTeams.find((team) =>
              team.id.toLowerCase() === defaultTeam?.toLowerCase() ||
              team.key.toLowerCase() === defaultTeam?.toLowerCase()
            )?.id

            const selectedTeam = await Select.prompt({
              message: "Team:",
              options: teamOptions,
              default: defaultTeamId,
            })
            teamIds = [selectedTeam]
          }

          // Status selection - get actual statuses from API
          if (!status) {
            const projectStatuses = await getProjectStatuses()

            if (projectStatuses.length > 0) {
              const statusOptions = projectStatuses.map(
                (s) => ({
                  name: s.name,
                  value: s.id,
                }),
              )

              // Find default (planned) status
              const defaultStatus = projectStatuses.find(
                (s) => s.type === "planned",
              )

              const selectedStatus = await Select.prompt({
                message: "Status:",
                options: statusOptions,
                default: defaultStatus?.id || statusOptions[0]?.value,
              })
              status = selectedStatus
            }
          }

          // Lead (optional)
          if (!lead) {
            lead = await Input.prompt({
              message: "Lead (username, email, or @me - press Enter to skip):",
            })
            if (!lead) lead = undefined
          }

          // Start date (optional)
          if (!startDate) {
            startDate = await Input.prompt({
              message: "Start date (YYYY-MM-DD - press Enter to skip):",
            })
            if (!startDate) startDate = undefined
          }

          // Target date (optional)
          if (!targetDate) {
            targetDate = await Input.prompt({
              message: "Target date (YYYY-MM-DD - press Enter to skip):",
            })
            if (!targetDate) targetDate = undefined
          }
        }

        const resolvedDescription = await resolveProjectDescription(
          description,
          undefined,
        )

        // Validate required fields
        if (!name) {
          throw new ValidationError("Project name is required", {
            suggestion: "Use --name or -n flag to specify a project name.",
          })
        }

        if (teams.length === 0 && teamIds == null) {
          // Try default team from config
          const defaultTeam = getTeamKey()
          if (defaultTeam) {
            teams = [defaultTeam]
          } else {
            throw new ValidationError("At least one team is required", {
              suggestion: "Use --team or -t flag to specify a team.",
            })
          }
        }

        // Resolve team IDs
        teamIds ??= await Promise.all(
          teams.map(async (team) => (await resolveTeam(team)).id),
        )

        // Build input - resolve all optional fields first
        let leadId: string | undefined
        if (lead != null) {
          leadId = await lookupUserId(lead)
          if (!leadId) {
            throw new NotFoundError("Lead", lead)
          }
        }

        const statusId = status == null
          ? undefined
          : await resolveProjectStatusId(status)

        const labelIds: string[] = []
        for (const label of labels) {
          const labelId = await lookupProjectLabelId(label)
          if (!labelId) {
            throw new NotFoundError("Project label", label)
          }
          labelIds.push(labelId)
        }

        const memberIds: string[] = []
        for (const member of members) {
          const memberId = await lookupUserId(member)
          if (!memberId) {
            throw new NotFoundError("User", member)
          }
          memberIds.push(memberId)
        }

        if (startDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
          throw new ValidationError("Start date must be in YYYY-MM-DD format")
        }

        if (targetDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
          throw new ValidationError("Target date must be in YYYY-MM-DD format")
        }

        const input: ProjectCreateInput = {
          name,
          teamIds,
          ...(resolvedDescription != null &&
            { description: resolvedDescription }),
          ...(content != null && { content }),
          ...(leadId && { leadId }),
          ...(statusId && { statusId }),
          ...(startDate != null && { startDate }),
          ...(targetDate != null && { targetDate }),
          ...(priority != null && { priority }),
          ...(labelIds.length > 0 && { labelIds }),
          ...(memberIds.length > 0 && { memberIds }),
          ...(providedIcon != null && { icon: providedIcon }),
          ...(providedColor != null && { color: providedColor }),
        }

        const { Spinner } = await import("@std/cli/unstable-spinner")
        const showSpinner = shouldShowSpinner() && !jsonOutput
        const spinner = showSpinner ? new Spinner() : null
        spinner?.start()

        try {
          const result = await client.request(CreateProject, { input })

          assertMutationSuccess(result?.projectCreate, result)
          const project = result.projectCreate.project
          spinner?.stop()
          assertMutationReceipt(project, result)

          if (jsonOutput) {
            printWriteResult(result.projectCreate)
          } else {
            console.log(`✓ Created project: ${project.name}`)
            console.log(`  Slug: ${project.slugId}`)
            if (project.url) {
              console.log(`  URL: ${project.url}`)
            }
          }
        } catch (error) {
          spinner?.stop()
          handleError(error, "Failed to create project")
        }
      } catch (error) {
        handleError(error, "Failed to create project")
      }
    },
  )
