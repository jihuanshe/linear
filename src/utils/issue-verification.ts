import { ValidationError } from "./errors.ts"
import { equivalentMarkdown } from "./markdown-equivalence.ts"
import type { Comparable, FieldReader } from "./replacement.ts"

function sameValue(a: Comparable, b: Comparable): boolean {
  return Array.isArray(a) || Array.isArray(b)
    ? Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => value === b[index])
    : a === b
}
export function differentIssueFields(
  issue: Record<string, unknown>,
  expected: Record<string, Comparable>,
  readers: Record<string, FieldReader>,
): string[] {
  const different: string[] = []
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
    const normalized = reader.normalize(desired)
    const matches = name === "description" &&
        typeof actual === "string" && typeof normalized === "string"
      ? equivalentMarkdown(normalized, actual)
      : sameValue(actual, normalized)
    if (!matches) {
      different.push(reader.field)
    }
  }
  return different
}

export interface ReadBackOptions {
  verificationTimeoutMs?: number
  verificationDelay?: (milliseconds: number) => Promise<void>
}

/** Retries only observation after a confirmed write. */
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
  for (const wait of [250, 750]) {
    if (result.verification.status === "verified" || signal.aborted) break
    await delay(wait)
    result = await read(signal)
  }
  return result
}
