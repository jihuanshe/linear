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
import { guidesCommand } from "./commands/guides/guides.ts"
import { configCommand } from "./commands/config.ts"
import { schemaCommand } from "./commands/schema.ts"
import { apiCommand } from "./commands/api.ts"
import { updateCommand } from "./commands/update.ts"
import { uploadCommand } from "./commands/upload.ts"
import { versionCommand } from "./commands/version.ts"
import {
  createUsageAction,
  createUsageCommand,
  type UsageCommandSource,
} from "./commands/usage.ts"
import { guidesForCommandPath } from "./guides/guides.ts"
import { setCliWorkspace } from "./config.ts"
import { supportsStdoutStyling } from "./utils/terminal.ts"

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
  .version(denoConfig.version)
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
  .globalAction((options) => {
    setCliWorkspace(options.workspace)
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
  .command("guides", guidesCommand)
  .command("completions", new CompletionsCommand())
  .command("config", configCommand)
  .alias("configure")
  .command("schema", schemaCommand)
  .command("api", apiCommand)
  .command("upload", uploadCommand)
  .command("update", updateCommand)
  .command("version", versionCommand)

interface UsageInjectable extends UsageCommandSource {
  hasCommands(): boolean
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
