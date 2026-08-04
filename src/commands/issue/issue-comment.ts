import { Command } from "@cliffy/command"
import { commentAddCommand } from "./issue-comment-add.ts"
import { commentDeleteCommand } from "./issue-comment-delete.ts"
import { commentUpdateCommand } from "./issue-comment-update.ts"
import { commentListCommand } from "./issue-comment-list.ts"
import { withUsageMetadata } from "../usage.ts"

export const commentCommand = new Command()
  .description("Manage issue comments")
  .action(function () {
    this.showHelp()
  })
  .command(
    "add",
    withUsageMetadata(commentAddCommand, { writes: true, interactive: true }),
  )
  .command(
    "delete",
    withUsageMetadata(commentDeleteCommand, {
      writes: true,
      interactive: true,
      confirmationRequiredUnless: "--confirm",
    }),
  )
  .command(
    "update",
    withUsageMetadata(commentUpdateCommand, {
      writes: true,
      interactive: true,
    }),
  )
  .command("list", commentListCommand)
