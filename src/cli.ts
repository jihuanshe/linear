import { Command } from "@cliffy/command"
import { CompletionsCommand } from "@cliffy/command/completions"
import denoConfig from "../deno.json" with { type: "json" }
import { authCommand } from "./commands/auth/auth.ts"
import { issueCommand } from "./commands/issue/issue.ts"
import { teamCommand } from "./commands/team/team.ts"
import { userCommand } from "./commands/user/user.ts"
import { projectCommand } from "./commands/project/project.ts"
import { projectUpdateCommand } from "./commands/project-update/project-update.ts"
import { cycleCommand } from "./commands/cycle/cycle.ts"
import { milestoneCommand } from "./commands/milestone/milestone.ts"
import { initiativeCommand } from "./commands/initiative/initiative.ts"
import { initiativeUpdateCommand } from "./commands/initiative-update/initiative-update.ts"
import { labelCommand } from "./commands/label/label.ts"
import { documentCommand } from "./commands/document/document.ts"
import { guideCommand } from "./commands/guide/guide.ts"
import { recipeCommand } from "./commands/recipe.ts"
import { configCommand } from "./commands/config.ts"
import { schemaCommand } from "./commands/schema.ts"
import { apiCommand } from "./commands/api.ts"
import { updateCommand } from "./commands/update.ts"
import { downloadCommand } from "./commands/download.ts"
import { uploadCommand } from "./commands/upload.ts"
import { versionCommand } from "./commands/version.ts"
import {
  createUsageAction,
  createUsageCommand,
  outputModes,
  type UsageCommandSource,
  withUsageMetadata,
} from "./commands/usage.ts"
import { guidesForCommandPath } from "./guides/guides.ts"
import { setCliWorkspace } from "./config.ts"
import { supportsStdoutStyling } from "./utils/terminal.ts"
import { setMachineOutput } from "./utils/write-result.ts"
import { UnsupportedOutputError, ValidationError } from "./utils/errors.ts"

// Import config and credentials setup
import "./config.ts"
import "./credentials.ts"

// The root command. Kept in this internal module (rather than the package entry
// point src/main.ts) so its complex inferred cliffy type stays out of the
// published public API and doesn't trip the no-slow-types check.
export const cli = new Command()
  .name("linear")
  .throwErrors()
  .help({ colors: supportsStdoutStyling() })
  .helpOption("-h, --help", "Show this help.", {
    action: function (options) {
      guardMachineOutput.call(this, options)
      this.showHelp({ long: this.getRawArgs().includes("--help") })
    },
  })
  .version(denoConfig.version)
  .versionOption("-V, --version", "Show the version number for this program.", {
    action: function (options) {
      guardMachineOutput.call(this, options)
      // Keep the original build-identity line; capability metadata belongs in
      // usage/help, not in the legacy --version response.
      if (this.getRawArgs().includes("--version")) {
        console.log(this.getLongVersion().split("\n")[0])
      } else this.showVersion()
    },
  })
  .description(
    `Handy linear commands from the command line.

Environment Variables:
  LINEAR_DEBUG=1             Show full error details including stack traces
  LINEAR_PROMPT_DISABLED=1   Disable all interactive prompts`,
  )
  .globalOption(
    "--workspace <slug:string>",
    "Target workspace (uses credentials)",
  )
  .globalOption(
    "-j, --json",
    "Output JSON where supported",
    { action: guardMachineOutput },
  )
  .globalAction((options) => {
    setCliWorkspace(options.workspace)
    // Once parsing succeeded, a literal '--json' used as an option value must
    // not select machine output. Raw api sets its always-JSON mode in action.
    setMachineOutput((options as { json?: boolean }).json === true)
  })
  .action(createUsageAction(false))
  .command("auth", authCommand)
  .command("issue", issueCommand)
  .alias("i")
  .command("team", teamCommand)
  .alias("t")
  .command("user", userCommand)
  .alias("u")
  .command("project", projectCommand)
  .alias("p")
  .command("project-update", projectUpdateCommand)
  .alias("pu")
  .command("cycle", cycleCommand)
  .alias("cy")
  .command("milestone", milestoneCommand)
  .alias("m")
  .command("initiative", initiativeCommand)
  .alias("init")
  .command("initiative-update", initiativeUpdateCommand)
  .alias("iu")
  .command("label", labelCommand)
  .alias("l")
  .command("document", documentCommand)
  .command("guide", guideCommand)
  .command("recipe", recipeCommand)
  .command("completions", new CompletionsCommand())
  .command("config", configCommand)
  .alias("configure")
  .command("schema", schemaCommand)
  .command("api", apiCommand)
  .command("upload", uploadCommand)
  .command("download", downloadCommand)
  .command("update", updateCommand)
  .command("version", versionCommand)

interface UsageInjectable extends UsageCommandSource {
  hasCommands(): boolean
  reset(): unknown
  meta(name: string, value: string): unknown
  getCommands(): UsageInjectable[]
  getCommand(name: string): UsageInjectable | undefined
  command(
    name: string,
    command: ReturnType<typeof createUsageCommand>,
  ): unknown
}

function injectUsageCommands(
  command: UsageInjectable,
  includeSubcommandOptions = true,
): void {
  for (const child of command.getCommands()) {
    if (child.getName() !== "completions") {
      injectUsageCommands(child)
    }
  }
  if (
    command.getName() !== "completions" && command.hasCommands() &&
    command.getCommand("usage") == null
  ) {
    command.command(
      "usage",
      createUsageCommand(command, includeSubcommandOptions),
    )
  }
}

injectUsageCommands(cli, false)

/** Option actions bind the resolved leaf, unlike root globalAction. */
function guardMachineOutput(
  this: UsageCommandSource,
  parsedOptions: unknown,
): void {
  const options = (parsedOptions ?? {}) as Record<string, unknown>
  setMachineOutput(options.json === true)
  if (options.json !== true) return

  // Standalone help/version may bypass globalAction, and option actions run
  // concurrently. Each printing action must therefore perform its own guard.
  if (options.help || options.version) {
    throw new ValidationError(
      "--json cannot be combined with --help or --version",
      {
        suggestion:
          "Use 'linear usage --json' (or '<domain> usage --json') for command metadata, or 'linear version --json' for build identity.",
      },
    )
  }
  if (!outputModes(this).includes("json")) {
    throw new UnsupportedOutputError(this.getPath())
  }
  const exclusive = new Set([
    "web",
    "app",
    "interactive",
    "edit",
    "raw",
    "source",
    "silent",
  ])
  for (const option of this.getBaseOptions()) {
    // Cliffy names a negative definition "no-interactive", so it is not an
    // explicit positive selector. Display toggles and --no-pager are compatible.
    if (exclusive.has(option.name) && options[option.name] === true) {
      throw new ValidationError(
        `--json cannot be combined with --${option.name}`,
        {
          suggestion: `Remove --${option.name} to receive JSON on stdout.`,
        },
      )
    }
  }
}

function wireMachineOutput(command: UsageInjectable): void {
  if (command.getName() === "completions") return
  command.reset()
  if (command.hasCommands()) {
    withUsageMetadata(command, { outputModes: ["human", "json"] })
  }
  const json = command.getBaseOptions().find((option) => option.name === "json")
  if (json != null && !json.global) {
    // A local option shadows the entire global option, including aliases and
    // actions. Keep its definition/typing/description and wire the same guard.
    json.aliases ??= []
    if (!json.aliases.includes("j")) json.aliases.push("j")
    if (!json.flags.includes("-j")) json.flags.unshift("-j")
    const action = json.action
    json.action = function (options, ...args) {
      guardMachineOutput.call(this, options)
      return action?.call(this, options, ...args)
    }
  }
  for (const child of command.getCommands()) wireMachineOutput(child)
}

wireMachineOutput(cli)

// Cliffy's completion commands disable inherited globals. Accept the selector
// there too, solely to reject it with the same machine error before execution.
const completionCommands = [cli.getCommand("completions")!]
const jsonOption = cli.getBaseOptions().find((option) =>
  option.name === "json"
)!
for (const command of completionCommands) {
  completionCommands.push(...command.getCommands(true))
  command.reset()
    .globalOption(jsonOption.flags.join(", "), jsonOption.description, {
      action: guardMachineOutput,
    })
    .globalAction(guardMachineOutput)
}

// Leaf help carries a "Related guides" breadcrumb derived from guide
// frontmatter (src/guides/guides.ts owns the relationship); domains render
// theirs in their usage view instead. A breadcrumb names the guide and never
// embeds its body.
interface GuideAnnotatable {
  getPath(): string
  hasCommands(): boolean
  getCommands(): GuideAnnotatable[]
  meta(name: string, value: string): unknown
}

function annotateRelatedGuides(command: GuideAnnotatable): void {
  if (command.hasCommands()) {
    for (const child of command.getCommands()) {
      annotateRelatedGuides(child)
    }
    return
  }
  const related = guidesForCommandPath(command.getPath())
  if (related.length > 0) {
    command.meta(
      "Related guides",
      related.map((guide) => guide.name).join(", "),
    )
  }
}

annotateRelatedGuides(cli)
