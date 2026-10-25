import { ValidationError } from "./errors.ts"
import { compareMarkdown } from "./markdown-equivalence.ts"
import type { Comparable, FieldReader } from "./replacement.ts"

function sameValue(a: Comparable, b: Comparable): boolean {
  return Array.isArray(a) || Array.isArray(b)
    ? Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => value === b[index])
    : a === b
}
/**
 * Compare a read-back Issue with the written values. `normalized` lists the
 * Markdown fields that match only after Linear's save-time rewrites.
 */
export function compareIssueFields(
  issue: Record<string, unknown>,
  expected: Record<string, Comparable>,
  readers: Record<string, FieldReader>,
): { different: string[]; normalized: string[] } {
  const different: string[] = []
  const normalized: string[] = []
  for (const [name, desired] of Object.entries(expected)) {
    if (name === "addedLabelIds" || name === "removedLabelIds") {
      const labels = new Set(
        readers.labelIds.read(issue) as string[],
      )
      const ids = readers.labelIds.normalize(
        desired,
      ) as string[]
      if (
        !ids.every((id) =>
          name === "addedLabelIds" ? labels.has(id) : !labels.has(id)
        )
      ) {
        different.push(name)
      }
      continue
    }
    const reader = readers[name]
    if (reader == null) {
      throw new ValidationError(
        "Unsupported recorded expected field: " + name,
      )
    }
    const actual = reader.read(issue)
    const written = reader.normalize(desired)
    if (
      name === "description" &&
      typeof actual === "string" && typeof written === "string"
    ) {
      const match = compareMarkdown(written, actual)
      if (match === "different") different.push(reader.field)
      else if (match === "normalized") normalized.push(reader.field)
    } else if (!sameValue(actual, written)) {
      different.push(reader.field)
    }
  }
  return { different, normalized }
}

export interface ReadBackOptions {
  verificationTimeoutMs?: number
  verificationDelay?: (milliseconds: number) => Promise<void>
}

/**
 * Waits before each reread: up to five reads in about four seconds, since
 * Linear can briefly serve the value from before the write.
 */
export const READ_BACK_WAITS_MS = [250, 500, 1000, 2000] as const

/** Reread stale values after a confirmed write; transport owns server retries. */
export async function withReadBackRetries<
  T extends {
    verification: { status: "verified" | "different" | "unavailable" }
  },
>(
  read: (signal: AbortSignal) => Promise<T>,
  options: ReadBackOptions = {},
): Promise<T> {
  const signal = AbortSignal.timeout(options.verificationTimeoutMs ?? 10_000)
  const delay = options.verificationDelay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let result = await read(signal)
  for (const wait of READ_BACK_WAITS_MS) {
    if (result.verification.status !== "different" || signal.aborted) break
    await delay(wait)
    if (signal.aborted) break
    result = await read(signal)
  }
  return result
}
