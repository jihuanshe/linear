import { ValidationError } from "@cliffy/command"
import {
  type FlagOptions,
  parseFlags,
} from "../third_party/cliffy-flags/mod.ts"
import { initializeStdoutColors } from "./utils/terminal.ts"
import { handleError } from "./utils/errors.ts"
import { setMachineOutput } from "./utils/write-result.ts"

interface OutputCommandSource {
  getOptions(hidden?: boolean): FlagOptions[]
  getMeta(): Record<string, string>
  getCommand(name: string): OutputCommandSource | undefined
}

/**
 * Select the error channel without executing actions, option transforms or
 * validators. Use the real flags parser for value ownership, short clusters
 * and -- literals. The real command parse remains the authority on validity.
 * Before imports load configuration, only the two root globals are known.
 */
function machineOutputRequested(
  args: string[],
  command?: OutputCommandSource,
): boolean {
  const globals: FlagOptions[] = [
    { name: "json", aliases: ["j"] },
    { name: "workspace", args: [{ type: "string" }] },
  ]
  let remaining = args
  let json = false
  let rawApi = false
  let inCommandPath = true
  while (remaining.length > 0) {
    const flags = (command?.getOptions(true) ?? globals).map((option) => ({
      name: option.name,
      aliases: option.aliases,
      collect: true,
      preserveEmpty: option.args?.length ? option.preserveEmpty : true,
      // Accept even invalid boolean assignments here so --json=false/garbage
      // returns a JSON parse failure; the real boolean switch takes no value.
      equalsSign: option.args?.length ? option.equalsSign : true,
      args: option.args?.length
        ? option.args.map(({ type, optional, variadic, list, separator }) => ({
          type,
          optional,
          variadic,
          list,
          separator,
        }))
        : [{ type: "string", optional: true }],
    }))
    try {
      const parsed = parseFlags(remaining, {
        flags,
        stopEarly: true,
        stopOnUnknown: true,
        dotted: false,
        parse: ({ value }) => value,
        option: (option) => {
          if (option.name === "json") json = true
        },
      })
      remaining = parsed.unknown
    } catch {
      // A missing value at the end cannot hide a later JSON switch. Never
      // replace the actual parser's diagnostic with this best-effort probe.
      break
    }
    const next = remaining.shift()
    if (next != null && !next.startsWith("-") && inCommandPath) {
      const child = command?.getCommand(next)
      if (child != null) {
        command = child
        rawApi = child.getMeta()["Output modes"] === "json"
      } else {
        if (command == null) rawApi = next === "api"
        inCommandPath = false
      }
    }
  }
  return json || rawApi
}

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
  // Also cover parse failures before an action can inspect its parsed options.
  setMachineOutput(machineOutputRequested(Deno.args))
  try {
    const { cli } = await import("./cli.ts")
    setMachineOutput(machineOutputRequested(Deno.args, cli))
    // GraphQL imports configuration; keep initialization inside this error
    // boundary so malformed local config cannot escape as an uncaught stack.
    const { withGraphQLContext } = await import("./utils/graphql.ts")
    const legacyWorkspaceError = getLegacyLabelWorkspaceError(Deno.args)
    if (legacyWorkspaceError) {
      // This compatibility diagnostic treats a following switch as a missing
      // workspace value, unlike Cliffy's required-string value consumption.
      setMachineOutput(machineOutputRequested(Deno.args))
      if (Deno.args.includes("--json") || Deno.args.includes("-j")) {
        setMachineOutput(true)
      }
      throw new ValidationError(legacyWorkspaceError)
    }
    await withGraphQLContext(() => cli.parse(Deno.args))
  } catch (error) {
    handleError(error)
  }
}
