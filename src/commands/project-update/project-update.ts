import { Command } from "@cliffy/command"
import { createCommand } from "./project-update-create.ts"
import { listCommand } from "./project-update-list.ts"
import { withUsageMetadata } from "../usage.ts"

export const projectUpdateCommand = new Command()
  .name("project-update")
  .description("Manage project status updates")
  .action(function () {
    this.showHelp()
  })
  .command(
    "create",
    withUsageMetadata(createCommand, { writes: true, interactive: true }),
  )
  .command("list", listCommand)
