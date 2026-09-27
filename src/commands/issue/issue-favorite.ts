import { Command } from "@cliffy/command"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getIssueReference } from "../../utils/linear.ts"
import { readIssueHeader } from "../../utils/issue-read.ts"
import { completeConnection } from "../../utils/pagination.ts"
import {
  assertMutationReferences,
  assertMutationSuccess,
  handleError,
  ValidationError,
} from "../../utils/errors.ts"
import { printWriteResult, writeResult } from "../../utils/write-result.ts"
import { createUsageAction, withUsageMetadata } from "../usage.ts"

const ListFavorites = gql(`
  query ListFavorites($after: String, $first: Int) {
    favorites(after: $after, first: $first) {
      nodes {
        id
        type
        title
        url
        folderName
        issue { id identifier }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

const CreateFavorite = gql(`
  mutation CreateFavorite($input: FavoriteCreateInput!) {
    favoriteCreate(input: $input) {
      success
      favorite { id type title url folderName issue { id identifier } }
    }
  }
`)

const DeleteFavorite = gql(`
  mutation DeleteFavorite($id: String!) {
    favoriteDelete(id: $id) { success }
  }
`)

/** The authenticated user's complete favorites; the API has no target filter. */
export async function listFavorites() {
  const client = getGraphQLClient()
  const first = await client.request(ListFavorites, { first: 100 })
  return await completeConnection(
    first.favorites,
    async (after, pageSize) =>
      (await client.request(ListFavorites, { after, first: pageSize }))
        .favorites,
    "favorites",
  )
}

async function resolveIssue(reference: string) {
  const resolved = await getIssueReference(reference)
  if (resolved == null) {
    throw new ValidationError(`Could not resolve issue reference: ${reference}`)
  }
  const { id, identifier } = await readIssueHeader(resolved)
  return { id, identifier }
}

/** Favorite an issue unless the viewer already has it; returns the favorite. */
export async function addIssueFavorite(
  reference: string,
  folderName?: string,
) {
  const issue = await resolveIssue(reference)
  const existing = (await listFavorites()).nodes.find((favorite) =>
    favorite.issue?.id === issue.id
  )
  if (existing != null) {
    return writeResult({ issue, favorite: existing }, { effect: "none" })
  }
  const data = await getGraphQLClient().request(CreateFavorite, {
    input: { issueId: issue.id, folderName },
  })
  assertMutationSuccess(data.favoriteCreate, data)
  const favorite = data.favoriteCreate.favorite
  assertMutationReferences(favorite, data, { issue: issue.id })
  return writeResult({ issue, favorite })
}

/** Remove the viewer's favorite of an issue; a missing favorite is a no-op. */
export async function removeIssueFavorite(reference: string) {
  const issue = await resolveIssue(reference)
  const existing = (await listFavorites()).nodes.find((favorite) =>
    favorite.issue?.id === issue.id
  )
  if (existing == null) {
    return writeResult({ issue, favorite: null }, { effect: "none" })
  }
  const data = await getGraphQLClient().request(DeleteFavorite, {
    id: existing.id,
  })
  assertMutationSuccess(data.favoriteDelete, data)
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
        nodes: all.nodes.filter((favorite) => favorite.issue != null),
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
        const folder = favorite.folderName == null
          ? ""
          : ` [${favorite.folderName}]`
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
  .option("--folder <name:string>", "Favorites folder name")
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
