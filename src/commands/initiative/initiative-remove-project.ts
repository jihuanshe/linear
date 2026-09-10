import { resolveInitiativeId as resolveStableInitiativeId } from "./initiative-resolve.ts"
import { resolveProjectId as resolveStableProjectId } from "../../utils/linear.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Confirm } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { completeConnection } from "../../utils/pagination.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"
import {
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

const GetInitiativeToProjects = gql(`
  query GetInitiativeToProjects($first: Int, $after: String) {
    initiativeToProjects(first: $first, after: $after) {
      nodes {
        id
        initiative {
          id
        }
        project {
          id
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

const RemoveProjectFromInitiative = gql(`
  mutation RemoveProjectFromInitiative($id: String!) {
    initiativeToProjectDelete(id: $id) {
      success
    }
  }
`)

async function resolveInitiativeId(
  client: ReturnType<typeof getGraphQLClient>,
  reference: string,
): Promise<{ id: string; name: string }> {
  const id = await resolveStableInitiativeId(client, reference)
  const query = gql(`
    query GetInitiativeNameByIdForRemove($id: String!) {
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
    query GetProjectNameByIdForRemove($id: String!) {
      project(id: $id) { id name }
    }
  `)
  const result = await client.request(query, { id })
  if (!result.project?.id) throw new NotFoundError("Project", reference)
  return result.project
}

export const removeProjectCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--force",
  outputModes: ["human", "json"],
})
  .name("remove-project")
  .option("--json", "Output a JSON write result")
  .description("Unlink a project from an initiative")
  .arguments("<initiative:string> <project:string>")
  .option("-y, --force", "Skip confirmation prompt")
  .action(
    async (
      { force, json },
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

      // Find the initiative-to-project link
      let linkId: string | undefined

      try {
        const linkResult = await client.request(GetInitiativeToProjects, {
          first: 250,
        })

        const links = await completeConnection(
          linkResult.initiativeToProjects,
          async (after) => {
            const next = await client.request(GetInitiativeToProjects, {
              first: 250,
              after,
            })
            return next.initiativeToProjects
          },
          "initiative project links",
        )
        const link = links.nodes.find(
          (node) =>
            node.initiative?.id === initiative.id &&
            node.project?.id === project.id,
        )
        if (link) {
          linkId = link.id
        }
      } catch (error) {
        handleError(error, "Failed to find project link")
      }

      if (!linkId) {
        if (json) {
          printWriteResult({
            initiativeId: initiative.id,
            projectId: project.id,
            linked: false,
          }, { effect: "none" })
          return
        }
        console.log(
          `Project "${project.name}" is not linked to initiative "${initiative.name}"`,
        )
        return
      }

      // Confirm removal
      if (!force) {
        if (json || !Deno.stdin.isTerminal()) {
          throw new ValidationError(
            "Interactive confirmation required. Use --force to skip.",
          )
        }
        const confirmed = await Confirm.prompt({
          message:
            `Remove "${project.name}" from initiative "${initiative.name}"?`,
          default: true,
        })

        if (!confirmed) {
          console.log("Removal cancelled.")
          return
        }
      }

      const { Spinner } = await import("@std/cli/unstable-spinner")
      const showSpinner = !json && shouldShowSpinner()
      const spinner = showSpinner ? new Spinner() : null
      spinner?.start()

      try {
        const result = await client.request(RemoveProjectFromInitiative, {
          id: linkId,
        })

        spinner?.stop()

        assertMutationSuccess(result?.initiativeToProjectDelete, {
          id: linkId,
          initiativeId: initiative.id,
          projectId: project.id,
          result: result?.initiativeToProjectDelete,
        })
        if (json) {
          printWriteResult({
            id: linkId,
            initiativeId: initiative.id,
            projectId: project.id,
            success: true,
          })
          return
        }

        console.log(
          `✓ Removed "${project.name}" from initiative "${initiative.name}"`,
        )
      } catch (error) {
        spinner?.stop()
        handleError(error, "Failed to remove project from initiative")
      }
    },
  )
