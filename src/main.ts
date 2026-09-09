import { ValidationError } from "@cliffy/command"
import { initializeStdoutColors } from "./utils/terminal.ts"
import { handleError } from "./utils/errors.ts"
import { setMachineOutput } from "./utils/write-result.ts"

function getLegacyLabelWorkspaceError(args: string[]): string | undefined {
  const labelIndex = args.findIndex((arg) => arg === "label" || arg === "l")
  if (labelIndex === -1 || args[labelIndex + 1] !== "list") return

  const workspaceIndex = args.indexOf("--workspace", labelIndex + 2)
  if (workspaceIndex === -1) return

  const value = args[workspaceIndex + 1]
  if (value != null && !value.startsWith("-")) return

  return 'Missing value for option "--workspace". To list workspace-level labels, use "--workspace-labels".'
}

function rawApiRequested(args: string[]): boolean {
  let index = 0
  while (index < args.length) {
    if (args[index] === "--workspace") index += 2
    else if (args[index].startsWith("--workspace=")) index++
    else return args[index] === "api"
  }
  return false
}

if (import.meta.main) {
  initializeStdoutColors()
  // Also cover parse failures before an action can inspect its parsed options.
  setMachineOutput(
    Deno.args.includes("--json") || Deno.args.includes("-j") ||
      rawApiRequested(Deno.args),
  )
  try {
    const { cli } = await import("./cli.ts")
    // GraphQL imports configuration; keep initialization inside this error
    // boundary so malformed local config cannot escape as an uncaught stack.
    const { withGraphQLContext } = await import("./utils/graphql.ts")
    const legacyWorkspaceError = getLegacyLabelWorkspaceError(Deno.args)
    if (legacyWorkspaceError) {
      throw new ValidationError(legacyWorkspaceError)
    }
    await withGraphQLContext(() => cli.parse(Deno.args))
  } catch (error) {
    handleError(error)
  }
}
