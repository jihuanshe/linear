import { Command } from "@cliffy/command"
import { listCommand } from "./label-list.ts"
import { createCommand } from "./label-create.ts"
import { deleteCommand } from "./label-delete.ts"
import { withUsageMetadata } from "../usage.ts"

export const labelCommand = new Command()
  .description("Manage Linear issue labels")
  .action(function () {
    this.showHelp()
  })
  .command("list", listCommand)
  .command(
    "create",
    withUsageMetadata(createCommand, { writes: true, interactive: true }),
  )
  .command(
    "delete",
    withUsageMetadata(deleteCommand, {
      writes: true,
      interactive: true,
      confirmationRequiredUnless: "--force",
    }),
  )
