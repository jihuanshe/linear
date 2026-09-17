import { ValidationError } from "../../utils/errors.ts"

export function validateMilestoneTargetDate(targetDate: string): void {
  const date = new Date(targetDate)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== targetDate
  ) {
    throw new ValidationError(
      "Target date must be a valid calendar date in YYYY-MM-DD format",
    )
  }
}
