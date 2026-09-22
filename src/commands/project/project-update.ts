import { Command } from "@cliffy/command"
import { getCliWorkspace } from "../../config.ts"
import { readTextSource } from "../../utils/text-source.ts"
import { resolveProjectStatusId } from "./project-status.ts"
import { withUsageMetadata } from "../usage.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { ProjectUpdateInput } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { resolveTeam } from "../../utils/issue-read.ts"
import {
  lookupProjectLabelId,
  lookupUserId,
  resolveProjectId,
} from "../../utils/linear.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  connectionField,
  loadBasisFile,
  prepareReplacement,
  referenceField,
  scalarField,
  validateReplacementOptions,
} from "../../utils/replacement.ts"
import { readProject } from "./project-read.ts"
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
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  resolveProjectDescription,
} from "./project-description.ts"

const UpdateProject = gql(`
  mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
      project {
        id
        slugId
        name
        description
        content
        url
        updatedAt
        startDate
        targetDate
        status { id }
        lead { id }
      }
    }
  }
`)

export const updateCommand = withUsageMetadata(new Command(), { writes: true })
  .name("update")
  .description("Update a Linear project by UUID, slug ID, or exact name")
  .arguments("<project:string>")
  .option("-n, --name <name:string>", "Project name", { preserveEmpty: true })
  .option(
    "-d, --description <description:string>",
    `Project description (max ${PROJECT_DESCRIPTION_MAX_LENGTH} characters, enforced by Linear's API; empty string clears it)`,
    { preserveEmpty: true },
  )
  .option(
    "-f, --description-file <path:string>",
    `Read UTF-8 project description from a file (- for stdin; still subject to the ${PROJECT_DESCRIPTION_MAX_LENGTH}-character API limit)`,
    { preserveEmpty: true },
  )
  .option(
    "--content <content:string>",
    "Replace project overview Markdown; empty string clears it",
    { preserveEmpty: true },
  )
  .option(
    "--content-file <path:string>",
    "Read UTF-8 project overview Markdown from a file (- for stdin); replaces the full content",
    { preserveEmpty: true },
  )
  .option(
    "-s, --status <status:string>",
    "Status UUID or type (planned, started, paused, completed, canceled, backlog)",
    { preserveEmpty: true },
  )
  .option(
    "-l, --lead <lead:string>",
    "Project lead (user UUID, username, name, email, 'self', or '@me')",
    { preserveEmpty: true },
  )
  .option("--start-date <date:string>", "Start date (YYYY-MM-DD)", {
    preserveEmpty: true,
  })
  .option("--target-date <date:string>", "Target date (YYYY-MM-DD)", {
    preserveEmpty: true,
  })
  .option(
    "-t, --team <team:string>",
    "Replace project teams with these UUIDs or keys (can be repeated)",
    { collect: true, preserveEmpty: true },
  )
  .option("-j, --json", "Output the write result as JSON")
  .option(
    "--base-file <path:string>",
    "Saved view --json output from before editing",
    { preserveEmpty: true },
  )
  .option(
    "--unprotected",
    "Skip original-value comparison; domain checks still apply",
  )
  .option(
    "--expect-field <field:string>",
    "Require this API field to match the saved original value (repeatable)",
    { collect: true, preserveEmpty: true },
  )
  .option(
    "--label <label:string>",
    "Replace the project's labels by UUID or exact name. May be repeated to set multiple labels.",
    { collect: true, preserveEmpty: true },
  )
  .action(
    async (
      {
        name,
        description,
        descriptionFile,
        content,
        contentFile,
        status,
        lead,
        startDate,
        targetDate,
        team: teams,
        label: labels,
        json,
        baseFile,
        unprotected,
        expectField,
      },
      projectReference,
    ) => {
      const { Spinner } = await import("@std/cli/unstable-spinner")
      const showSpinner = shouldShowSpinner() && !json
      const spinner = showSpinner ? new Spinner() : null

      try {
        for (
          const [field, value] of Object.entries({
            name,
            status,
            lead,
            "start-date": startDate,
            "target-date": targetDate,
          })
        ) {
          if (value != null && value.trim() === "") {
            throw new ValidationError(`--${field} cannot be empty`)
          }
        }
        if (teams?.some((team) => team.trim() === "")) {
          throw new ValidationError("--team cannot be empty")
        }
        if (
          name == null && description == null && descriptionFile == null &&
          content == null && contentFile == null && status == null &&
          lead == null && startDate == null && targetDate == null &&
          (!teams || teams.length === 0) &&
          (!labels || labels.length === 0)
        ) {
          throw new ValidationError(
            "At least one update option must be provided",
            {
              suggestion:
                "Use --name, --description, --description-file, --content, --content-file, --status, --lead, --start-date, --target-date, --team, or --label",
            },
          )
        }

        if (labels) {
          for (const label of labels) {
            if (label.trim() === "") {
              throw new ValidationError("Project label cannot be empty", {
                suggestion: 'Provide a label name, e.g. --label "My Label".',
              })
            }
          }
        }

        const resolvedDescription = await resolveProjectDescription(
          description,
          descriptionFile,
        )
        const resolvedContent = await readTextSource(
          "content",
          content,
          contentFile,
        )
        const original = baseFile != null
          ? await loadBasisFile(baseFile)
          : undefined

        if (startDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
          throw new ValidationError("Start date must be in YYYY-MM-DD format")
        }

        if (targetDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
          throw new ValidationError("Target date must be in YYYY-MM-DD format")
        }

        validateReplacementOptions({
          original,
          unprotected,
          expectFields: expectField,
          readCommand: {
            command: ["project"],
            target: projectReference,
            workspace: getCliWorkspace(),
          },
        })

        spinner?.start()
        const client = getGraphQLClient()
        const resolvedId = await resolveProjectId(projectReference)

        const input: ProjectUpdateInput = {}

        if (name != null) input.name = name
        if (resolvedDescription != null) input.description = resolvedDescription
        if (resolvedContent != null) input.content = resolvedContent
        if (startDate != null) input.startDate = startDate
        if (targetDate != null) input.targetDate = targetDate

        if (status != null) {
          input.statusId = await resolveProjectStatusId(status)
        }

        if (lead != null) {
          const leadId = await lookupUserId(lead)
          if (!leadId) {
            spinner?.stop()
            throw new NotFoundError("Lead", lead)
          }
          input.leadId = leadId
        }

        if (teams && teams.length > 0) {
          input.teamIds = await Promise.all(
            teams.map(async (team) => (await resolveTeam(team)).id),
          )
        }

        if (labels && labels.length > 0) {
          // Replace the project's labels with exactly the resolved set,
          // matching `project update --team` and `issue update --label`.
          const labelIds: string[] = []
          const seen = new Set<string>()
          for (const label of labels) {
            const labelId = await lookupProjectLabelId(label)
            if (!labelId) {
              spinner?.stop()
              throw new NotFoundError("Project label", label)
            }
            if (!seen.has(labelId)) {
              seen.add(labelId)
              labelIds.push(labelId)
            }
          }
          input.labelIds = labelIds
        }

        const current = await readProject(client, resolvedId)
        const plan = prepareReplacement({
          objectKey: "project",
          targetId: resolvedId,
          original,
          current,
          desired: input,
          fields: {
            name: scalarField("name"),
            description: scalarField("description"),
            content: scalarField("content"),
            startDate: scalarField("startDate"),
            targetDate: scalarField("targetDate"),
            statusId: referenceField("status"),
            leadId: referenceField("lead"),
            teamIds: connectionField("teams"),
            labelIds: connectionField("labels"),
          },
          unprotected,
          expectFields: expectField,
        })
        if (Object.keys(plan.input).length === 0) {
          spinner?.stop()
          if (json) {
            printWriteResult({ project: current.project }, {
              effect: "none",
              fields: plan.fields,
            })
          } else console.log("No changes needed")
          return
        }
        const writeInput = { ...plan.input }
        // Linear currently requires LF to clear Markdown content. Keep the
        // desired empty string in the replacement plan, but encode only the
        // actual mutation payload.
        if (writeInput.content === "") writeInput.content = "\n"

        const result = await client.request(UpdateProject, {
          id: resolvedId,
          input: writeInput,
        })
        spinner?.stop()

        assertMutationSuccess(result.projectUpdate, result)
        const project = result.projectUpdate.project
        assertMutationReceipt(project, result, resolvedId)

        let verification:
          | { status: "verified"; content: string | null }
          | undefined
        if (plan.input.content === "") {
          try {
            const readBack = await readProject(client, resolvedId)
            if (
              readBack.project.content != null &&
              readBack.project.content !== ""
            ) {
              throw new CliError("Project content is not empty on read-back")
            }
            verification = {
              status: "verified",
              content: readBack.project.content,
            }
          } catch (error) {
            throw new WriteError(
              "The project update was applied, but clearing content could not be verified.",
              {
                effect: "applied",
                data: { project },
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
                  "Inspect the project before retrying. No automatic retry was performed.",
              },
            )
          }
        }

        if (json) {
          printWriteResult({ project }, { fields: plan.fields, verification })
        } else {
          console.log(`✓ Updated project: ${project.name}`)
          if (project.url) console.log(project.url)
        }
      } catch (error) {
        spinner?.stop()
        handleError(error, "Failed to update project")
      }
    },
  )
