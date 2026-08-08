import { Command } from "@cliffy/command"
import { createUsageAction } from "../usage.ts"

import { listCommand } from "./user-list.ts"

export const userCommand = new Command()
  .description("Manage Linear users")
  .action(createUsageAction(true))
  .command("list", listCommand)
