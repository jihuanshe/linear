import { CliError } from "./errors.ts"

export interface Connection<T> {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

/** Accumulate a typed connection without losing its final pagination boundary. */
export async function completeConnection<T>(
  initial: Connection<T>,
  fetchNext: (after: string, first: number) => Promise<Connection<T>>,
  label: string,
  limit = 0,
): Promise<Connection<T>> {
  const nodes: T[] = []
  const seenCursors = new Set<string>()
  let page = initial
  while (true) {
    if (!Array.isArray(page?.nodes)) {
      throw new CliError(`Incomplete ${label} pagination: missing nodes`)
    }
    if (
      page.pageInfo == null || typeof page.pageInfo.hasNextPage !== "boolean" ||
      !(page.pageInfo.endCursor === null ||
        typeof page.pageInfo.endCursor === "string")
    ) {
      throw new CliError(`Incomplete ${label} pagination: missing pageInfo`)
    }
    nodes.push(...page.nodes)
    const { pageInfo } = page
    if (!pageInfo.hasNextPage) return { nodes, pageInfo }
    const after = pageInfo.endCursor
    if (!after || seenCursors.has(after)) {
      throw new CliError(
        `Incomplete ${label} pagination: empty or repeated cursor`,
      )
    }
    seenCursors.add(after)
    if (limit > 0 && nodes.length >= limit) return { nodes, pageInfo }
    page = await fetchNext(
      after,
      limit > 0 ? Math.min(100, limit - nodes.length) : 100,
    )
  }
}

/**
 * Human output hides pageInfo, so say on stderr when --limit left more pages.
 * stdout stays unchanged; JSON callers keep pageInfo instead.
 */
export function warnIfTruncated(
  connection: { nodes: unknown[]; pageInfo: { hasNextPage: boolean } },
  singular: string,
  plural: string,
): void {
  if (!connection.pageInfo.hasNextPage) return
  const count = connection.nodes.length
  console.error(
    `Showing the first ${count} ${
      count === 1 ? singular : plural
    }; more exist. Use --limit 0 to fetch all pages.`,
  )
}
