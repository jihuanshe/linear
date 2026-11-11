import { Command } from "@cliffy/command"
import { createUsageAction } from "../usage.ts"
import { listCommand } from "./label-list.ts"
import { createCommand } from "./label-create.ts"
import { deleteCommand } from "./label-delete.ts"
import { viewCommand } from "./label-view.ts"
import { updateCommand } from "./label-update.ts"

export const labelCommand = new Command()
  .description("Manage Linear issue labels")
  .action(createUsageAction(true))
  .command("list", listCommand)
  .command("view", viewCommand)
  .command("create", createCommand)
  .command("update", updateCommand)
  .command("delete", deleteCommand)
