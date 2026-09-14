import { Command } from "@cliffy/command"
import { commentAddCommand } from "./issue-comment-add.ts"
import { commentDeleteCommand } from "./issue-comment-delete.ts"
import { commentUpdateCommand } from "./issue-comment-update.ts"
import { commentListCommand } from "./issue-comment-list.ts"
import { commentViewCommand } from "./issue-comment-view.ts"
import {
  commentResolveCommand,
  commentUnresolveCommand,
} from "./issue-comment-resolve.ts"

export const commentCommand = new Command()
  .description("Manage issue comments")
  .action(function () {
    this.showHelp()
  })
  .command("add", commentAddCommand)
  .command("delete", commentDeleteCommand)
  .command("update", commentUpdateCommand)
  .command("list", commentListCommand)
  .command("view", commentViewCommand)
  .command("resolve", commentResolveCommand)
  .command("unresolve", commentUnresolveCommand)
