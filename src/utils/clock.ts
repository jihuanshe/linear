import { ValidationError } from "./errors.ts"

/**
 * The current time for displayed relative dates. LINEAR_NOW (an ISO 8601
 * instant) pins it so output can be reproduced; waiting and request deadlines
 * always use the real clock.
 */
export function currentTime(): Date {
  const pinned = Deno.env.get("LINEAR_NOW")
  if (pinned == null) return new Date()
  // An instant needs a date, a time and a zone; other formats would be read
  // in the local time zone or locale.
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
      .exec(pinned)
  const date = new Date(pinned)
  if (iso == null || Number.isNaN(date.getTime()) || !isCalendarTime(iso)) {
    throw new ValidationError(`LINEAR_NOW is not a valid date: ${pinned}`, {
      suggestion:
        "Set an ISO 8601 instant such as 2026-01-01T00:00:00Z, or unset it.",
    })
  }
  return date
}

/** Reject dates such as February 30 that Date would roll into the next month. */
function isCalendarTime(match: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second = 0] = match.slice(1, 7)
    .map((part) => part == null ? undefined : Number(part)) as number[]
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day && utc.getUTCHours() === hour &&
    utc.getUTCMinutes() === minute && utc.getUTCSeconds() === second
}
