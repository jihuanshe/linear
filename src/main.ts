import { ValidationError } from "@cliffy/command"
import { initializeStdoutColors } from "./utils/terminal.ts"
import { handleError } from "./utils/errors.ts"

function getLegacyLabelWorkspaceError(args: string[]): string | undefined {
  const labelIndex = args.findIndex((arg) => arg === "label" || arg === "l")
  if (labelIndex === -1 || args[labelIndex + 1] !== "list") return

  const workspaceIndex = args.indexOf("--workspace", labelIndex + 2)
  if (workspaceIndex === -1) return

  const value = args[workspaceIndex + 1]
  if (value != null && !value.startsWith("-")) return

  return 'Missing value for option "--workspace". To list workspace-level labels, use "--workspace-labels".'
}

if (import.meta.main) {
  initializeStdoutColors()
  try {
    const { cli } = await import("./cli.ts")
    const legacyWorkspaceError = getLegacyLabelWorkspaceError(Deno.args)
    if (legacyWorkspaceError) {
      throw new ValidationError(legacyWorkspaceError)
    }
    await cli.parse(Deno.args)
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(`error: ${error.message}`)
      Deno.exitCode = error.exitCode
    } else {
      handleError(error)
    }
  }
}
