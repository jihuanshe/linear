import { Command } from "@cliffy/command"
import { createUsageAction } from "../usage.ts"

import { createCommand } from "./initiative-update-create.ts"
import { listCommand } from "./initiative-update-list.ts"

export const initiativeUpdateCommand = new Command()
  .name("initiative-update")
  .description("Manage initiative status updates (timeline posts)")
  .action(createUsageAction(true))
  .command("create", createCommand)
  .command("list", listCommand)
  .alias("ls")
