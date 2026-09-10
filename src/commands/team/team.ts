import { Command } from "@cliffy/command"
import { createUsageAction } from "../usage.ts"

import { keyCommand } from "./team-key.ts"
import { membersCommand } from "./team-members.ts"
import { listCommand } from "./team-list.ts"
import { statesCommand } from "./team-states.ts"
import { createCommand } from "./team-create.ts"
import { deleteCommand } from "./team-delete.ts"

export const teamCommand = new Command()
  .description("Manage Linear teams")
  .action(createUsageAction(true))
  .command("create", createCommand)
  .command("delete", deleteCommand)
  .command("list", listCommand)
  .command("key", keyCommand)
  .command("members", membersCommand)
  .command("states", statesCommand)
