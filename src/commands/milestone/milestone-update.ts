import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { ProjectMilestoneUpdateInput } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { resolveProjectId } from "../../utils/linear.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  CliError,
  errorResult,
  handleError,
  ValidationError,
  WriteError,
} from "../../utils/errors.ts"
import {
  loadBasisFile,
  prepareReplacement,
  referenceField,
  scalarField,
  validateReplacementOptions,
} from "../../utils/replacement.ts"
import { readMilestone } from "./milestone-read.ts"
import { printWriteResult } from "../../utils/write-result.ts"

const UpdateProjectMilestone = gql(`
  mutation UpdateProjectMilestone($id: String!, $input: ProjectMilestoneUpdateInput!) {
    projectMilestoneUpdate(id: $id, input: $input) {
      success
      projectMilestone {
        id
        name
        description
        targetDate
        sortOrder
        project {
          id
          name
        }
      }
    }
  }
`)

export const updateCommand = withUsageMetadata(new Command(), { writes: true })
  .name("update")
  .description("Update an existing project milestone")
  .arguments("<id:string>")
  .option("--name <name:string>", "Milestone name", { preserveEmpty: true })
  .option(
    "--description <description:string>",
    "Milestone description; empty string clears it",
    { preserveEmpty: true },
  )
  .option("--target-date <date:string>", "Target date (YYYY-MM-DD)")
  .option(
    "--sort-order <value:number>",
    "Sort order relative to other milestones",
  )
  .option(
    "--project <project:string>",
    "Move to a different project (UUID, slug ID, or name)",
  )
  .option("-j, --json", "Output the write result as JSON")
  .option(
    "--base-file <path:string>",
    "Original view --json output, saved before preparing the update",
    { preserveEmpty: true },
  )
  .option(
    "--unprotected",
    "Explicitly skip original-value comparison; domain checks still apply",
  )
  .option(
    "--expect-field <field:string>",
    "Also require this API field to match the original basis",
    { collect: true },
  )
  .action(
    async (
      {
        name,
        description,
        targetDate,
        sortOrder,
        project: projectIdOrSlug,
        json,
        baseFile,
        unprotected,
        expectField,
      },
      id,
    ) => {
      const { Spinner } = await import("@std/cli/unstable-spinner")
      const showSpinner = shouldShowSpinner() && !json
      const spinner = showSpinner ? new Spinner() : null
      spinner?.start()

      try {
        if (name != null && !name.trim()) {
          throw new ValidationError("Milestone name cannot be empty")
        }
        if (
          name == null && description == null && !targetDate &&
          sortOrder == null &&
          !projectIdOrSlug
        ) {
          throw new ValidationError(
            "At least one update option must be provided",
            {
              suggestion:
                "Use --name, --description, --target-date, --sort-order, or --project",
            },
          )
        }
        if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
          throw new ValidationError("Target date must be in YYYY-MM-DD format")
        }
        const original = baseFile != null
          ? await loadBasisFile(baseFile)
          : undefined
        validateReplacementOptions({
          original,
          unprotected,
          expectFields: expectField,
        })
        const client = getGraphQLClient()
        const input: ProjectMilestoneUpdateInput = {}

        if (name != null) input.name = name
        if (description != null) input.description = description
        if (targetDate) input.targetDate = targetDate
        if (sortOrder != null) input.sortOrder = sortOrder
        if (projectIdOrSlug) {
          // Resolve project slug to full UUID
          input.projectId = await resolveProjectId(projectIdOrSlug)
        }

        const current = await readMilestone(client, id)
        const resolvedId = current.projectMilestone!.id
        const plan = prepareReplacement({
          objectKey: "projectMilestone",
          targetId: resolvedId,
          original,
          current,
          desired: input,
          fields: {
            name: scalarField("name"),
            description: scalarField("description"),
            targetDate: scalarField("targetDate"),
            sortOrder: scalarField("sortOrder"),
            projectId: referenceField("project"),
          },
          unprotected,
          expectFields: expectField,
        })
        if (Object.keys(plan.input).length === 0) {
          spinner?.stop()
          if (json) {
            printWriteResult({ projectMilestone: current.projectMilestone }, {
              effect: "none",
              fields: plan.fields,
            })
          } else console.log("No changes needed")
          return
        }
        const writeInput = { ...plan.input }
        // Linear ignores an empty description but accepts LF to clear it.
        // Keep the exact desired Markdown for comparison; encode only on wire.
        // Evidence: https://github.com/jihuanshe/linear/pull/38
        if (writeInput.description === "") writeInput.description = "\n"
        const result = await client.request(UpdateProjectMilestone, {
          id: resolvedId,
          input: writeInput,
        })
        spinner?.stop()

        assertMutationSuccess(result.projectMilestoneUpdate, result)
        const milestone = result.projectMilestoneUpdate.projectMilestone
        assertMutationReceipt(milestone, result, resolvedId)
        let verification: { status: string; description: string } | undefined
        if (plan.input.description === "") {
          try {
            const readBack = await readMilestone(client, resolvedId)
            if (
              milestone.description !== "" ||
              readBack.projectMilestone.description !== ""
            ) {
              throw new CliError(
                "Milestone description is not empty in the mutation receipt or read-back",
              )
            }
            verification = { status: "verified", description: "" }
          } catch (error) {
            throw new WriteError(
              "The milestone update was applied, but clearing description could not be verified.",
              {
                effect: "applied",
                data: { projectMilestone: milestone },
                cause: error,
                details: {
                  fields: plan.fields,
                  verification: {
                    status: "unverified",
                    message: errorResult(error).error.message,
                  },
                },
                suggestion:
                  "Inspect the milestone before retrying. No automatic retry was performed.",
              },
            )
          }
        }
        if (json) {
          printWriteResult({ projectMilestone: milestone }, {
            fields: plan.fields,
            verification,
          })
        } else {
          console.log(`✓ Updated milestone: ${milestone.name}`)
          console.log(`  ID: ${milestone.id}`)
          if (milestone.targetDate) {
            console.log(`  Target Date: ${milestone.targetDate}`)
          }
          console.log(`  Sort Order: ${milestone.sortOrder}`)
          console.log(`  Project: ${milestone.project.name}`)
        }
      } catch (error) {
        spinner?.stop()
        handleError(error, "Failed to update milestone")
      }
    },
  )
