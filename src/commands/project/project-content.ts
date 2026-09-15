import { ValidationError } from "../../utils/errors.ts"

export async function resolveProjectContent(
  content: string | undefined,
  contentFile: string | undefined,
): Promise<string | undefined> {
  if (content != null && contentFile != null) {
    throw new ValidationError(
      "Cannot specify both --content and --content-file",
    )
  }

  if (contentFile == null) {
    return content
  }
  if (contentFile === "") {
    throw new ValidationError("Content file path cannot be empty")
  }

  try {
    return await Deno.readTextFile(contentFile)
  } catch (error) {
    throw new ValidationError(`Failed to read content file: ${contentFile}`, {
      suggestion: `Error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
  }
}
