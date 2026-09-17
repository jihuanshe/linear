import type { ArgumentValue } from "@cliffy/command"
import { ValidationError } from "./errors.ts"

const priorityNames = ["none", "urgent", "high", "medium", "low"]

/** Parse CLI priorities to the numeric contract used by write operations. */
export function priorityType({ value }: ArgumentValue): number {
  if (/^[0-4]$/.test(value)) return Number(value)
  const priority = priorityNames.indexOf(value.toLowerCase())
  if (priority !== -1) return priority
  throw new ValidationError(`Invalid priority: ${value}`, {
    suggestion:
      "Use 0/none, 1/urgent, 2/high, 3/medium, or 4/low (names are case-insensitive).",
  })
}
