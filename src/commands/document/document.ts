import { Command } from "@cliffy/command"
import { listCommand } from "./document-list.ts"
import { viewCommand } from "./document-view.ts"
import { createCommand } from "./document-create.ts"
import { updateCommand } from "./document-update.ts"
import { deleteCommand } from "./document-delete.ts"
import { createUsageAction } from "../usage.ts"

export const documentCommand = new Command()
  .name("document")
  .description("Manage Linear documents")
  .action(createUsageAction(true))
  .command("list", listCommand)
  .alias("l")
  .command("view", viewCommand)
  .alias("v")
  .command("create", createCommand)
  .alias("c")
  .command("update", updateCommand)
  .alias("u")
  .command("delete", deleteCommand)
  .alias("d")
