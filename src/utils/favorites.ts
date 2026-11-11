import { gql } from "../__codegen__/gql.ts"
import { getGraphQLClient } from "./graphql.ts"
import { completeConnection } from "./pagination.ts"
import { assertMutationSuccess, ValidationError } from "./errors.ts"

const ListFavorites = gql(`
  query ListFavorites($after: String, $first: Int) {
    favorites(after: $after, first: $first) {
      nodes {
        id
        type
        title
        url
        folderName
        parent { id folderName }
        issue { id identifier }
        project { id slugId name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

const DeleteFavorite = gql(`
  mutation DeleteFavorite($id: String!) {
    favoriteDelete(id: $id) { success }
  }
`)

/** The authenticated user's complete favorites, used for list and folder lookup. */
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

interface ExistingFavorite {
  parent?: { folderName?: string | null } | null
}

/**
 * Refuse to move an existing favorite into another folder; `add` only creates
 * or keeps a favorite.
 */
export function assertFavoriteFolder(
  existing: ExistingFavorite,
  folderName: string | undefined,
  target: string,
): void {
  if (folderName == null || existing.parent?.folderName === folderName) return
  const current = existing.parent?.folderName == null
    ? "the root favorites list"
    : `folder ${JSON.stringify(existing.parent.folderName)}`
  throw new ValidationError(
    `${target} is already favorited in ${current}; cannot place it in folder ${
      JSON.stringify(folderName)
    } without removing it first`,
  )
}

/** The ID of the viewer's one favorites folder with this exact name. */
export async function resolveFavoriteFolder(
  folderName: string,
): Promise<string> {
  const folders = (await listFavorites()).nodes.filter((favorite) =>
    favorite.type === "folder" && favorite.folderName === folderName
  )
  if (folders.length === 0) {
    throw new ValidationError(`Favorite folder not found: ${folderName}`)
  }
  if (folders.length > 1) {
    throw new ValidationError(
      `Favorite folder name is ambiguous: ${
        JSON.stringify(folderName)
      } matches ${folders.length} folders`,
    )
  }
  return folders[0].id
}

export async function deleteFavorite(id: string): Promise<void> {
  const data = await getGraphQLClient().request(DeleteFavorite, { id })
  assertMutationSuccess(data.favoriteDelete, data)
}
