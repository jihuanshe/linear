import { Command } from "@cliffy/command"
import { createUsageAction } from "../usage.ts"

import { defaultCommand } from "./auth-default.ts"
import { listCommand } from "./auth-list.ts"
import { loginCommand } from "./auth-login.ts"
import { logoutCommand } from "./auth-logout.ts"
import { migrateCommand } from "./auth-migrate.ts"
import { tokenCommand } from "./auth-token.ts"
import { whoamiCommand } from "./auth-whoami.ts"

export const authCommand = new Command()
  .description("Manage Linear authentication")
  .action(createUsageAction(true))
  .command("login", loginCommand)
  .command("logout", logoutCommand)
  .command("list", listCommand)
  .command("default", defaultCommand)
  .command("token", tokenCommand)
  .command("whoami", whoamiCommand)
  .command("migrate", migrateCommand)
