import { resolveInitiativeId } from "./initiative-resolve.ts"
import { resolveProjectId } from "../../utils/linear.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { completeConnection } from "../../utils/pagination.ts"
import {
  assertMutationReferences,
  assertMutationSuccess,
  handleError,
  NotFoundError,
} from "../../utils/errors.ts"
import { printWriteResult } from "../../utils/write-result.ts"

const GetProjectInitiativeLinksForAdd = gql(`
  query GetProjectInitiativeLinksForAdd($id: String!, $after: String) {
    project(id: $id) {
      initiativeToProjects(first: 250, after: $after, includeArchived: true) {
        nodes { id initiative { id } project { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)

const AddProjectToInitiative = gql(`
  mutation AddProjectToInitiative($input: InitiativeToProjectCreateInput!) {
    initiativeToProjectCreate(input: $input) {
      success
      initiativeToProject {
        id
        initiative { id }
        project { id }
      }
    }
  }
`)

async function resolveInitiative(
  client: ReturnType<typeof getGraphQLClient>,
  reference: string,
): Promise<{ id: string; name: string }> {
  const id = await resolveInitiativeId(client, reference)
  const query = gql(`
    query GetInitiativeNameById($id: String!) {
      initiative(id: $id) { id name }
    }
  `)
  const result = await client.request(query, { id })
  if (!result.initiative?.id) throw new NotFoundError("Initiative", reference)
  return result.initiative
}

async function resolveProject(
  client: ReturnType<typeof getGraphQLClient>,
  reference: string,
): Promise<{ id: string; name: string }> {
  const id = await resolveProjectId(reference)
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
})
  .name("add-project")
  .option("--json", "Output a JSON write result")
  .description(
    "Link a project to an initiative; each accepts a UUID, slug ID, or name. An existing direct link is unchanged, including its sort order.",
  )
  .arguments("<initiative:string> <project:string>")
  .option("--sort-order <order:number>", "Sort order for a new link only", {
    preserveEmpty: true,
  })
  .action(
    async (
      { sortOrder, json },
      initiativeArg,
      projectArg,
    ) => {
      const client = getGraphQLClient()

      // Resolve initiative
      const initiative = await resolveInitiative(client, initiativeArg)
      if (!initiative) {
        throw new NotFoundError("Initiative", initiativeArg)
      }

      // Resolve project
      const project = await resolveProject(client, projectArg)
      if (!project) {
        throw new NotFoundError("Project", projectArg)
      }

      try {
        const readLinks = async (after?: string) => {
          const result = await client.request(GetProjectInitiativeLinksForAdd, {
            id: project.id,
            after,
          })
          return result.project.initiativeToProjects
        }
        const links = await completeConnection(
          await readLinks(),
          readLinks,
          "initiative project links",
        )
        const link = links.nodes.find((node) =>
          node.initiative.id === initiative.id && node.project.id === project.id
        )
        if (link) {
          if (json) {
            printWriteResult({
              id: link.id,
              initiativeId: initiative.id,
              projectId: project.id,
            }, { effect: "none" })
          } else {
            console.log(
              `Project "${project.name}" is already linked to initiative "${initiative.name}"`,
            )
          }
          return
        }
      } catch (error) {
        handleError(error, "Failed to find project link")
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
        assertMutationReferences(link, {
          ...input,
          result: result?.initiativeToProjectCreate,
        }, {
          initiative: initiative.id,
          project: project.id,
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
