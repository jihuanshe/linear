import { Command } from "@cliffy/command"
import { createUsageAction } from "../usage.ts"

import { idCommand } from "./team-id.ts"
import { autolinksCommand } from "./team-autolinks.ts"
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
  .command("id", idCommand)
  .command("autolinks", autolinksCommand)
  .command("members", membersCommand)
  .command("states", statesCommand)
