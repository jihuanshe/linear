import { Command } from "@cliffy/command"
import { createUsageAction } from "../usage.ts"
import { attachCommand } from "./issue-attach.ts"
import { commentCommand } from "./issue-comment.ts"
import { createCommand } from "./issue-create.ts"
import { deleteCommand } from "./issue-delete.ts"
import { idCommand } from "./issue-id.ts"
import { linkCommand } from "./issue-link.ts"
import { queryCommand } from "./issue-query.ts"
import { relationCommand } from "./issue-relation.ts"
import { issueApplyCommand } from "./issue-apply.ts"
import { issuePlanCommand } from "./issue-plan.ts"
import { historyCommand } from "./issue-history.ts"
import { pickCommand } from "./issue-pick.ts"
import { titleCommand } from "./issue-title.ts"
import { updateCommand } from "./issue-update.ts"
import { urlCommand } from "./issue-url.ts"
import { viewCommand } from "./issue-view.ts"
import { exportCommand } from "./issue-export.ts"

export const issueCommand = new Command()
  .description("Manage Linear issues")
  .action(createUsageAction(true))
  .command("id", idCommand)
  .command("query", queryCommand)
  .alias("q")
  .command("title", titleCommand)
  .command("pick", pickCommand)
  .command("view", viewCommand)
  .command("export", exportCommand)
  .command("history", historyCommand)
  .command("url", urlCommand)
  .command("delete", deleteCommand)
  .command("create", createCommand)
  .command("update", updateCommand)
  .command("comment", commentCommand)
  .command("attach", attachCommand)
  .command("link", linkCommand)
  .command("relation", relationCommand)
  .command("plan", issuePlanCommand)
  .command("apply", issueApplyCommand)
