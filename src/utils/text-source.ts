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
  // `--body-file --json` means the path was missing and the parser took the
  // next option as the value, e.g. an unquoted zsh variable that did not split.
  if (file.startsWith("-") && file !== "-") {
    throw new ValidationError(
      `--${field}-file got ${file}, which looks like an option: the file path is probably missing`,
      {
        suggestion:
          `Pass the path right after --${field}-file. zsh does not split unquoted variables, so one "KEY path" variable stays one argument. For a file whose name starts with -, write ./${file}.`,
      },
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
