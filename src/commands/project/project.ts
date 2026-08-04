import { Command } from "@cliffy/command"
import { listCommand } from "./project-list.ts"
import { viewCommand } from "./project-view.ts"
import { createCommand } from "./project-create.ts"
import { updateCommand } from "./project-update.ts"
import { deleteCommand } from "./project-delete.ts"
import { withUsageMetadata } from "../usage.ts"

export const projectCommand = new Command()
  .description("Manage Linear projects")
  .action(function () {
    this.showHelp()
  })
  .command("list", listCommand)
  .command("view", viewCommand)
  .command(
    "create",
    withUsageMetadata(createCommand, { writes: true, interactive: true }),
  )
  .command("update", withUsageMetadata(updateCommand, { writes: true }))
  .command(
    "delete",
    withUsageMetadata(deleteCommand, {
      writes: true,
      interactive: true,
      confirmationRequiredUnless: "--force",
    }),
  )
