import { resolveInitiativeId as resolveStableInitiativeId } from "./initiative-resolve.ts"
import { resolveProjectId as resolveStableProjectId } from "../../utils/linear.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  NotFoundError,
} from "../../utils/errors.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"

const AddProjectToInitiative = gql(`
  mutation AddProjectToInitiative($input: InitiativeToProjectCreateInput!) {
    initiativeToProjectCreate(input: $input) {
      success
      initiativeToProject {
        id
      }
    }
  }
`)

async function resolveInitiativeId(
  client: ReturnType<typeof getGraphQLClient>,
  reference: string,
): Promise<{ id: string; name: string }> {
  const id = await resolveStableInitiativeId(client, reference)
  const query = gql(`
    query GetInitiativeNameById($id: String!) {
      initiative(id: $id) { id name }
    }
  `)
  const result = await client.request(query, { id })
  if (!result.initiative?.id) throw new NotFoundError("Initiative", reference)
  return result.initiative
}

async function resolveProjectId(
  client: ReturnType<typeof getGraphQLClient>,
  reference: string,
): Promise<{ id: string; name: string }> {
  const id = await resolveStableProjectId(reference)
  const query = gql(`
    query GetProjectNameById($id: String!) {
      project(id: $id) { id name }
    }
  `)
  const result = await client.request(query, { id })
  if (!result.project?.id) throw new NotFoundError("Project", reference)
  return result.project
}

export const addProjectCommand = withUsageMetadata(new Command(), {
  writes: true,
  outputModes: ["human", "json"],
})
  .name("add-project")
  .option("--json", "Output a JSON write result")
  .description("Link a project to an initiative")
  .arguments("<initiative:string> <project:string>")
  .option("--sort-order <sortOrder:number>", "Sort order within initiative")
  .action(
    async (
      { sortOrder, json },
      initiativeArg,
      projectArg,
    ) => {
      setMachineOutput(json ?? false)
      const client = getGraphQLClient()

      // Resolve initiative
      const initiative = await resolveInitiativeId(client, initiativeArg)
      if (!initiative) {
        throw new NotFoundError("Initiative", initiativeArg)
      }

      // Resolve project
      const project = await resolveProjectId(client, projectArg)
      if (!project) {
        throw new NotFoundError("Project", projectArg)
      }

      const { Spinner } = await import("@std/cli/unstable-spinner")
      const showSpinner = !json && shouldShowSpinner()
      const spinner = showSpinner ? new Spinner() : null
      spinner?.start()

      // Build input
      const input = {
        initiativeId: initiative.id,
        projectId: project.id,
        ...(sortOrder !== undefined && { sortOrder }),
      }

      try {
        const result = await client.request(AddProjectToInitiative, { input })

        spinner?.stop()

        assertMutationSuccess(result?.initiativeToProjectCreate, {
          ...input,
          result: result?.initiativeToProjectCreate,
        })
        const link = result?.initiativeToProjectCreate.initiativeToProject
        assertMutationReceipt(link, {
          ...input,
          result: result?.initiativeToProjectCreate,
        })
        if (json) {
          printWriteResult({
            ...link,
            initiativeId: initiative.id,
            projectId: project.id,
          })
          return
        }

        console.log(
          `✓ Added "${project.name}" to initiative "${initiative.name}"`,
        )
      } catch (error) {
        spinner?.stop()
        handleError(error, "Failed to add project to initiative")
      }
    },
  )
