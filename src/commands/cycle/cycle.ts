import { Command } from "@cliffy/command"
import { createUsageAction } from "../usage.ts"
import { listCommand } from "./cycle-list.ts"
import { viewCommand } from "./cycle-view.ts"

export const cycleCommand = new Command()
  .description("Manage Linear team cycles")
  .action(createUsageAction(true))
  .command("list", listCommand)
  .command("view", viewCommand)
