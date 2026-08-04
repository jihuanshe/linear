import { Command } from "@cliffy/command"
import { listCommand } from "./document-list.ts"
import { viewCommand } from "./document-view.ts"
import { createCommand } from "./document-create.ts"
import { updateCommand } from "./document-update.ts"
import { deleteCommand } from "./document-delete.ts"
import { withUsageMetadata } from "../usage.ts"

export const documentCommand = new Command()
  .name("document")
  .description("Manage Linear documents")
  .alias("docs")
  .alias("doc")
  .action(() => {
    console.log("Use --help to see available subcommands")
  })
  .command("list", listCommand)
  .command("view", viewCommand)
  .command(
    "create",
    withUsageMetadata(createCommand, { writes: true, interactive: true }),
  )
  .command(
    "update",
    withUsageMetadata(updateCommand, { writes: true, interactive: true }),
  )
  .command(
    "delete",
    withUsageMetadata(deleteCommand, {
      writes: true,
      interactive: true,
      confirmationRequiredUnless: "--yes",
    }),
  )
