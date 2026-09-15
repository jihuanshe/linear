import { Command } from "@cliffy/command"
import { listCommand } from "./document-list.ts"
import { viewCommand } from "./document-view.ts"
import { createCommand } from "./document-create.ts"
import { updateCommand } from "./document-update.ts"
import { deleteCommand } from "./document-delete.ts"
import { printJsonUsage } from "../usage.ts"

export const documentCommand = new Command()
  .name("document")
  .description("Manage Linear documents")
  .alias("docs")
  .alias("doc")
  .action(function (options) {
    if (printJsonUsage(this, options)) return
    console.log("Use --help to see available subcommands")
  })
  .command("list", listCommand)
  .command("view", viewCommand)
  .command("create", createCommand)
  .command("update", updateCommand)
  .command("delete", deleteCommand)
