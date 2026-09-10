import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { resolveProjectId } from "../../utils/linear.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  ValidationError,
} from "../../utils/errors.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"

const CreateProjectMilestone = gql(`
  mutation CreateProjectMilestone($input: ProjectMilestoneCreateInput!) {
    projectMilestoneCreate(input: $input) {
      success
      projectMilestone {
        id
        name
        targetDate
        project {
          id
          name
        }
      }
    }
  }
`)

export const createCommand = withUsageMetadata(new Command(), {
  writes: true,
  outputModes: ["human", "json"],
})
  .name("create")
  .option("--json", "Output a JSON write result")
  .description("Create a new project milestone")
  .option(
    "--project <project:string>",
    "Project (UUID, slug ID, or name)",
    { required: true },
  )
  .option("--name <name:string>", "Milestone name", { required: true })
  .option("--description <description:string>", "Milestone description")
  .option("--target-date <date:string>", "Target date (YYYY-MM-DD)", {
    preserveEmpty: true,
  })
  .action(
    async (
      { project: projectIdOrSlug, name, description, targetDate, json },
    ) => {
      setMachineOutput(json ?? false)
      const { Spinner } = await import("@std/cli/unstable-spinner")
      const showSpinner = !json && shouldShowSpinner()
      const spinner = showSpinner ? new Spinner() : null
      spinner?.start()

      try {
        if (!name.trim()) {
          throw new ValidationError("Milestone name is required")
        }
        if (targetDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
          throw new ValidationError("Target date must be in YYYY-MM-DD format")
        }
        // Resolve project slug to full UUID
        const projectId = await resolveProjectId(projectIdOrSlug)

        const client = getGraphQLClient()
        const result = await client.request(CreateProjectMilestone, {
          input: {
            projectId,
            name,
            description,
            targetDate,
          },
        })
        spinner?.stop()

        assertMutationSuccess(
          result?.projectMilestoneCreate,
          result?.projectMilestoneCreate,
        )
        const milestone = result.projectMilestoneCreate.projectMilestone
        assertMutationReceipt(milestone, result.projectMilestoneCreate)
        if (json) {
          printWriteResult(milestone)
          return
        }
        console.log(`✓ Created milestone: ${milestone.name}`)
        console.log(`  ID: ${milestone.id}`)
        if (milestone.targetDate) {
          console.log(`  Target Date: ${milestone.targetDate}`)
        }
        console.log(`  Project: ${milestone.project.name}`)
      } catch (error) {
        spinner?.stop()
        handleError(error, "Failed to create milestone")
      }
    },
  )
