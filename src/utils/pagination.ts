import type { ArgumentValue } from "@cliffy/command"
import { CliError, ValidationError } from "./errors.ts"

/**
 * Cliffy type for `--limit` options where 0 reads every page. Only plain
 * decimal digits within the safe integer range are accepted, so `1.5`, `1e3`,
 * `0x10` and `abc` fail as ValidationError during parsing, before any request.
 * Callers page with at most 100 nodes per request, so large limits never reach
 * Linear's 250-node `first` bound.
 */
export function limitType({ name, value }: ArgumentValue): number {
  const limit = /^\d+$/.test(value) ? Number(value) : NaN
  if (Number.isSafeInteger(limit)) return limit
  throw new ValidationError(
    `${name} must be a non-negative integer (got ${JSON.stringify(value)})`,
    {
      suggestion:
        `Use a whole number from 0 (all pages) to ${Number.MAX_SAFE_INTEGER}.`,
    },
  )
}

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
