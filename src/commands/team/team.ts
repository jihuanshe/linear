import { Command } from "@cliffy/command"

import { idCommand } from "./team-id.ts"
import { autolinksCommand } from "./team-autolinks.ts"
import { membersCommand } from "./team-members.ts"
import { listCommand } from "./team-list.ts"
import { statesCommand } from "./team-states.ts"
import { createCommand } from "./team-create.ts"
import { deleteCommand } from "./team-delete.ts"
import { withUsageMetadata } from "../usage.ts"

export const teamCommand = new Command()
  .description("Manage Linear teams")
  .action(function () {
    this.showHelp()
  })
  .command(
    "create",
    withUsageMetadata(createCommand, { writes: true, interactive: true }),
  )
  .command(
    "delete",
    withUsageMetadata(deleteCommand, {
      writes: true,
      interactive: true,
      confirmationRequiredUnless: "--force",
    }),
  )
  .command("list", listCommand)
  .command("id", idCommand)
  .command("autolinks", withUsageMetadata(autolinksCommand, { writes: true }))
  .command("members", membersCommand)
  .command("states", statesCommand)
