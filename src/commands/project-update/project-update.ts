import { Command } from "@cliffy/command"
import { createUsageAction } from "../usage.ts"
import { createCommand } from "./project-update-create.ts"
import { listCommand } from "./project-update-list.ts"

export const projectUpdateCommand = new Command()
  .name("project-update")
  .description("Manage project status updates")
  .action(createUsageAction(true))
  .command("create", createCommand)
  .command("list", listCommand)
