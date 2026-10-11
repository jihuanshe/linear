import { ValidationError } from "./errors.ts"

/**
 * The current time for displayed relative dates. LINEAR_NOW (an ISO 8601
 * instant) pins it so output can be reproduced; waiting and request deadlines
 * always use the real clock.
 */
export function currentTime(): Date {
  const pinned = Deno.env.get("LINEAR_NOW")
  if (pinned == null) return new Date()
  const date = new Date(pinned)
  if (pinned.trim() === "" || Number.isNaN(date.getTime())) {
    throw new ValidationError(`LINEAR_NOW is not a valid date: ${pinned}`, {
      suggestion:
        "Set an ISO 8601 instant such as 2026-01-01T00:00:00Z, or unset it.",
    })
  }
  return date
}
