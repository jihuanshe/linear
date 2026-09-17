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
 * Before importing the command tree, only the two root globals are known.
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

if (import.meta.main) {
  initializeStdoutColors()
  // Also cover parse failures before an action can inspect its parsed options.
  setMachineOutput(machineOutputRequested(Deno.args))
  try {
    const { cli } = await import("./cli.ts")
    setMachineOutput(machineOutputRequested(Deno.args, cli))
    const { withGraphQLContext } = await import("./utils/graphql.ts")
    await withGraphQLContext(() => cli.parse(Deno.args))
  } catch (error) {
    handleError(error)
  }
}
