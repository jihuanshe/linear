import { Command } from "@cliffy/command"

import { listCommand } from "./initiative-list.ts"
import { viewCommand } from "./initiative-view.ts"
import { createCommand } from "./initiative-create.ts"
import { archiveCommand } from "./initiative-archive.ts"
import { updateCommand } from "./initiative-update.ts"
import { unarchiveCommand } from "./initiative-unarchive.ts"
import { deleteCommand } from "./initiative-delete.ts"
import { addProjectCommand } from "./initiative-add-project.ts"
import { removeProjectCommand } from "./initiative-remove-project.ts"
import { withUsageMetadata } from "../usage.ts"

export const initiativeCommand = new Command()
  .description("Manage Linear initiatives")
  .action(function () {
    this.showHelp()
  })
  .command("list", listCommand)
  .alias("ls")
  .command("view", viewCommand)
  .command(
    "create",
    withUsageMetadata(createCommand, { writes: true, interactive: true }),
  )
  .command(
    "archive",
    withUsageMetadata(archiveCommand, {
      writes: true,
      interactive: true,
      confirmationRequiredUnless: "--force",
    }),
  )
  .command(
    "update",
    withUsageMetadata(updateCommand, { writes: true, interactive: true }),
  )
  .command(
    "unarchive",
    withUsageMetadata(unarchiveCommand, {
      writes: true,
      interactive: true,
      confirmationRequiredUnless: "--force",
    }),
  )
  .command(
    "delete",
    withUsageMetadata(deleteCommand, {
      writes: true,
      interactive: true,
      confirmationRequiredUnless: "--force",
    }),
  )
  .command(
    "add-project",
    withUsageMetadata(addProjectCommand, { writes: true }),
  )
  .command(
    "remove-project",
    withUsageMetadata(removeProjectCommand, {
      writes: true,
      interactive: true,
      confirmationRequiredUnless: "--force",
    }),
  )
