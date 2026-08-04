import { Command } from "@cliffy/command"

import { defaultCommand } from "./auth-default.ts"
import { listCommand } from "./auth-list.ts"
import { loginCommand } from "./auth-login.ts"
import { logoutCommand } from "./auth-logout.ts"
import { migrateCommand } from "./auth-migrate.ts"
import { tokenCommand } from "./auth-token.ts"
import { whoamiCommand } from "./auth-whoami.ts"
import { withUsageMetadata } from "../usage.ts"

export const authCommand = new Command()
  .description("Manage Linear authentication")
  .action(function () {
    this.showHelp()
  })
  .command(
    "login",
    withUsageMetadata(loginCommand, { writes: true, interactive: true }),
  )
  .command(
    "logout",
    withUsageMetadata(logoutCommand, {
      writes: true,
      interactive: true,
      confirmationRequiredUnless: "--force",
    }),
  )
  .command("list", listCommand)
  .command(
    "default",
    withUsageMetadata(defaultCommand, { writes: true, interactive: true }),
  )
  .command("token", tokenCommand)
  .command("whoami", whoamiCommand)
  .command("migrate", withUsageMetadata(migrateCommand, { writes: true }))
