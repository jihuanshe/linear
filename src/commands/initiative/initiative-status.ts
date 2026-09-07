import type { InitiativeStatus } from "../../__codegen__/graphql.ts"
import { ValidationError } from "../../utils/errors.ts"

// Keep the CLI's supported statuses shared by flags and interactive choices.
export const INITIATIVE_STATUSES: { name: string; value: InitiativeStatus }[] =
  [
    { name: "Planned", value: "Planned" },
    { name: "Active", value: "Active" },
    { name: "Completed", value: "Completed" },
  ]

export function parseInitiativeStatus(value: string): InitiativeStatus {
  const status = INITIATIVE_STATUSES.find((s) =>
    s.value.toLowerCase() === value.toLowerCase()
  )
  if (!status) {
    throw new ValidationError(
      `Invalid status: ${value}. Valid values: planned, active, completed`,
    )
  }
  return status.value
}
