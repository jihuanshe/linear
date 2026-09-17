import { ValidationError } from "./errors.ts"

/** Read one raw UTF-8 source. Undefined is absent; an empty source stays empty. */
export async function readTextSource(
  field: string,
  text?: string,
  file?: string,
): Promise<string | undefined> {
  if (text != null && file != null) {
    throw new ValidationError(
      `Cannot specify both --${field} and --${field}-file`,
    )
  }
  if (file == null) return text
  if (file === "") {
    throw new ValidationError(
      `${field[0].toUpperCase()}${field.slice(1)} file path cannot be empty`,
    )
  }
  try {
    const bytes = file === "-"
      ? new Uint8Array(await new Response(Deno.stdin.readable).arrayBuffer())
      : await Deno.readFile(file)
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    )
  } catch (error) {
    throw new ValidationError(`Failed to read ${field} file: ${file}`, {
      suggestion: `${
        error instanceof Error ? error.message : String(error)
      }. Provide a readable UTF-8 file; use - to read stdin through EOF.`,
    })
  }
}
