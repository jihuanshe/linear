import { ValidationError } from "../../utils/errors.ts"
import { readTextSource } from "../../utils/text-source.ts"

// Linear's API rejects project descriptions longer than this. The web UI
// accepts longer descriptions through a different endpoint, but the
// projectCreate / projectUpdate mutations exposed here are bound to this cap.
export const PROJECT_DESCRIPTION_MAX_LENGTH = 255

export async function resolveProjectDescription(
  description: string | undefined,
  descriptionFile: string | undefined,
): Promise<string | undefined> {
  const value = await readTextSource(
    "description",
    description,
    descriptionFile,
  )

  if (value != null && value.length > PROJECT_DESCRIPTION_MAX_LENGTH) {
    throw new ValidationError(
      `Project description is ${value.length} characters, exceeds the ${PROJECT_DESCRIPTION_MAX_LENGTH}-character limit enforced by Linear's API`,
      {
        suggestion:
          `Shorten the description to ${PROJECT_DESCRIPTION_MAX_LENGTH} characters or fewer, or use --content-file for the project overview.`,
      },
    )
  }

  return value
}
