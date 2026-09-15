import { Command } from "@cliffy/command"
import { agentSessionListCommand } from "./issue-agent-session-list.ts"
import { agentSessionViewCommand } from "./issue-agent-session-view.ts"
import { printJsonUsage } from "../usage.ts"

export const agentSessionCommand = new Command()
  .description("Manage agent sessions for an issue")
  .action(function (options) {
    if (printJsonUsage(this, options)) return
    this.showHelp()
  })
  .command("list", agentSessionListCommand)
  .command("view", agentSessionViewCommand)
