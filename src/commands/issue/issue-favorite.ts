import { Command } from "@cliffy/command"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getIssueReference } from "../../utils/linear.ts"
import { readIssueHeader } from "../../utils/issue-read.ts"
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
  ValidationError,
} from "../../utils/errors.ts"
import { printWriteResult, writeResult } from "../../utils/write-result.ts"
import { createUsageAction, withUsageMetadata } from "../usage.ts"

const CreateFavorite = gql(`
  mutation CreateFavorite($input: FavoriteCreateInput!) {
    favoriteCreate(input: $input) {
      success
      favorite {
        id
        type
        title
        url
        folderName
        parent { id folderName }
        issue { id identifier }
      }
    }
  }
`)

async function resolveIssue(reference: string) {
  const resolved = await getIssueReference(reference)
  if (resolved == null) {
    throw new ValidationError(`Could not resolve issue reference: ${reference}`)
  }
  const { id, identifier, favorite } = await readIssueHeader(resolved)
  return { id, identifier, favorite }
}

/** Favorite an issue unless the viewer already has it; returns the favorite. */
export async function addIssueFavorite(
  reference: string,
  folderName?: string,
) {
  const issue = await resolveIssue(reference)
  const existing = issue.favorite
  if (existing != null) {
    assertFavoriteFolder(existing, folderName, `Issue ${issue.identifier}`)
    return writeResult({ issue, favorite: existing }, { effect: "none" })
  }
  const parentId = folderName == null
    ? undefined
    : await resolveFavoriteFolder(folderName)
  const data = await getGraphQLClient().request(CreateFavorite, {
    input: { issueId: issue.id, ...(parentId == null ? {} : { parentId }) },
  })
  assertMutationSuccess(data.favoriteCreate, data)
  const favorite = data.favoriteCreate.favorite
  assertMutationReferences(favorite, data, {
    issue: issue.id,
    ...(parentId == null ? {} : { parent: parentId }),
  })
  return writeResult({ issue, favorite })
}

/** Remove the viewer's favorite of an issue; a missing favorite is a no-op. */
export async function removeIssueFavorite(reference: string) {
  const issue = await resolveIssue(reference)
  const existing = issue.favorite
  if (existing == null) {
    return writeResult({ issue, favorite: null }, { effect: "none" })
  }
  await deleteFavorite(existing.id)
  return writeResult({ issue, favorite: existing })
}

const listCommand = new Command()
  .name("list")
  .description("List the authenticated user's favorited issues")
  .option(
    "-j, --json",
    "Output {nodes, pageInfo} with every page read; nodes keep only issue favorites",
  )
  .action(async ({ json }) => {
    try {
      const all = await listFavorites()
      const favorites = {
        ...all,
        nodes: all.nodes.flatMap(({ project: _, ...favorite }) =>
          favorite.issue == null ? [] : [favorite]
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
        console.log(`${favorite.issue?.identifier}\t${favorite.title}${folder}`)
      }
    } catch (error) {
      handleError(error, "Failed to list favorites")
    }
  })

const addCommand = withUsageMetadata(new Command(), { writes: true })
  .name("add")
  .description(
    "Favorite an issue (UUID, identifier, or Linear Issue URL) for the authenticated user; an existing favorite is a no-op",
  )
  .arguments("<issue:string>")
  .option("--folder <name:string>", "Existing favorites folder name")
  .option("-j, --json", "Output {ok, effect, data: {issue, favorite}}")
  .action(async ({ folder, json }, issue) => {
    try {
      const result = await addIssueFavorite(issue, folder)
      if (json) printWriteResult(result.data, { effect: result.effect })
      else {
        console.log(
          `✓ ${
            result.effect === "none" ? "Already favorited" : "Favorited"
          }: ${result.data.issue.identifier}`,
        )
      }
    } catch (error) {
      handleError(error, "Failed to add favorite")
    }
  })

const removeCommand = withUsageMetadata(new Command(), { writes: true })
  .name("remove")
  .description(
    "Remove the authenticated user's favorite of an issue (UUID, identifier, or Linear Issue URL); a missing favorite is a no-op",
  )
  .arguments("<issue:string>")
  .option("-j, --json", "Output {ok, effect, data: {issue, favorite}}")
  .action(async ({ json }, issue) => {
    try {
      const result = await removeIssueFavorite(issue)
      if (json) printWriteResult(result.data, { effect: result.effect })
      else {
        console.log(
          `✓ ${
            result.effect === "none" ? "Not favorited" : "Removed favorite"
          }: ${result.data.issue.identifier}`,
        )
      }
    } catch (error) {
      handleError(error, "Failed to remove favorite")
    }
  })

export const favoriteCommand = new Command()
  .description("Manage the authenticated user's favorited issues")
  .action(createUsageAction(true))
  .command("list", listCommand)
  .command("add", addCommand)
  .command("remove", removeCommand)
