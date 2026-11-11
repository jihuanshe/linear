import { Command } from "@cliffy/command"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { resolveProjectId } from "../../utils/linear.ts"
import {
  assertFavoriteFolder,
  deleteFavorite,
  listFavorites,
  resolveFavoriteFolder,
} from "../../utils/favorites.ts"
import {
  assertMutationReferences,
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"
import { printWriteResult, writeResult } from "../../utils/write-result.ts"
import { createUsageAction, withUsageMetadata } from "../usage.ts"

const ProjectHeader = gql(`
  query GetProjectFavoriteHeader($id: String!) {
    project(id: $id) {
      id
      slugId
      name
      favorite { id type parent { id folderName } }
    }
  }
`)

const CreateProjectFavorite = gql(`
  mutation CreateProjectFavorite($input: FavoriteCreateInput!) {
    favoriteCreate(input: $input) {
      success
      favorite {
        id
        type
        title
        url
        folderName
        parent { id folderName }
        project { id slugId name }
      }
    }
  }
`)

const PROJECT_REFERENCE = "project UUID, slug ID, exact name, or Linear URL"

async function resolveProject(reference: string) {
  const id = await resolveProjectId(reference)
  const data = await getGraphQLClient().request(ProjectHeader, { id })
  if (data.project == null) throw new NotFoundError("Project", reference)
  if (
    typeof data.project.id !== "string" ||
    data.project.id.toLowerCase() !== id.toLowerCase()
  ) {
    throw new ValidationError(
      "Project header resolved to a different stable identity",
    )
  }
  const { slugId, name, favorite } = data.project
  return { id: data.project.id, slugId, name, favorite }
}

/** Favorite a project unless the viewer already has it; returns the favorite. */
export async function addProjectFavorite(
  reference: string,
  folderName?: string,
) {
  const project = await resolveProject(reference)
  const existing = project.favorite
  if (existing != null) {
    assertFavoriteFolder(existing, folderName, `Project ${project.name}`)
    return writeResult({ project, favorite: existing }, { effect: "none" })
  }
  const parentId = folderName == null
    ? undefined
    : await resolveFavoriteFolder(folderName)
  const data = await getGraphQLClient().request(CreateProjectFavorite, {
    input: {
      projectId: project.id,
      ...(parentId == null ? {} : { parentId }),
    },
  })
  assertMutationSuccess(data.favoriteCreate, data)
  const favorite = data.favoriteCreate.favorite
  assertMutationReferences(favorite, data, {
    project: project.id,
    ...(parentId == null ? {} : { parent: parentId }),
  })
  return writeResult({ project, favorite })
}

/** Remove the viewer's favorite of a project; a missing favorite is a no-op. */
export async function removeProjectFavorite(reference: string) {
  const project = await resolveProject(reference)
  const existing = project.favorite
  if (existing == null) {
    return writeResult({ project, favorite: null }, { effect: "none" })
  }
  await deleteFavorite(existing.id)
  return writeResult({ project, favorite: existing })
}

const listCommand = new Command()
  .name("list")
  .description("List the authenticated user's favorited projects")
  .option(
    "-j, --json",
    "Output {nodes, pageInfo} with every page read; nodes keep only project favorites",
  )
  .action(async ({ json }) => {
    try {
      const all = await listFavorites()
      const favorites = {
        ...all,
        nodes: all.nodes.flatMap(({ issue: _, ...favorite }) =>
          favorite.project == null ? [] : [favorite]
        ),
      }
      if (json) {
        console.log(JSON.stringify(favorites, null, 2))
        return
      }
      if (favorites.nodes.length === 0) {
        console.log("No favorites.")
        return
      }
      for (const favorite of favorites.nodes) {
        const folder = favorite.parent?.folderName == null
          ? ""
          : ` [${favorite.parent.folderName}]`
        console.log(`${favorite.project?.slugId}\t${favorite.title}${folder}`)
      }
    } catch (error) {
      handleError(error, "Failed to list favorites")
    }
  })

const addCommand = withUsageMetadata(new Command(), { writes: true })
  .name("add")
  .description(
    `Favorite a project (${PROJECT_REFERENCE}) for the authenticated user; an existing favorite is a no-op`,
  )
  .arguments("<project:string>")
  .option("--folder <name:string>", "Existing favorites folder name")
  .option("-j, --json", "Output {ok, effect, data: {project, favorite}}")
  .action(async ({ folder, json }, project) => {
    try {
      const result = await addProjectFavorite(project, folder)
      if (json) printWriteResult(result.data, { effect: result.effect })
      else {
        console.log(
          `✓ ${
            result.effect === "none" ? "Already favorited" : "Favorited"
          }: ${result.data.project.name}`,
        )
      }
    } catch (error) {
      handleError(error, "Failed to add favorite")
    }
  })

const removeCommand = withUsageMetadata(new Command(), { writes: true })
  .name("remove")
  .description(
    `Remove the authenticated user's favorite of a project (${PROJECT_REFERENCE}); a missing favorite is a no-op`,
  )
  .arguments("<project:string>")
  .option("-j, --json", "Output {ok, effect, data: {project, favorite}}")
  .action(async ({ json }, project) => {
    try {
      const result = await removeProjectFavorite(project)
      if (json) printWriteResult(result.data, { effect: result.effect })
      else {
        console.log(
          `✓ ${
            result.effect === "none" ? "Not favorited" : "Removed favorite"
          }: ${result.data.project.name}`,
        )
      }
    } catch (error) {
      handleError(error, "Failed to remove favorite")
    }
  })

export const favoriteCommand = new Command()
  .description("Manage the authenticated user's favorited projects")
  .action(createUsageAction(true))
  .command("list", listCommand)
  .command("add", addCommand)
  .command("remove", removeCommand)
