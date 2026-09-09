import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Select } from "../../utils/prompt.ts"
import { resolveIssueSort } from "../../config.ts"
import { getPriorityDisplay } from "../../utils/display.ts"
import { fetchIssuesForQuery, getTeamKey } from "../../utils/linear.ts"
import {
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

export const pickCommand = withUsageMetadata(new Command(), {
  interactive: true,
})
  .name("pick")
  .description(
    "Choose an unstarted issue and print its identifier; does not change Linear or VCS state",
  )
  .option("-A, --all-assignees", "Show issues for all assignees")
  .option("-U, --unassigned", "Show only unassigned issues")
  .action(async ({ allAssignees, unassigned }) => {
    try {
      const teamKey = getTeamKey()
      if (!teamKey) throw new ValidationError("Could not determine team key")
      if (allAssignees && unassigned) {
        throw new ValidationError(
          "Cannot specify both --all-assignees and --unassigned",
        )
      }
      const { nodes } = await fetchIssuesForQuery({
        teamKeys: [teamKey],
        state: ["unstarted"],
        assigneeIsMe: !unassigned && !allAssignees,
        unassigned,
        sort: resolveIssueSort(),
        limit: 0,
      })
      if (nodes.length === 0) {
        throw new NotFoundError("Unstarted issues", teamKey)
      }
      const identifier = await Select.prompt({
        message: "Select an issue:",
        search: true,
        searchLabel: "Search issues",
        options: nodes.map((issue) => ({
          name: `${
            getPriorityDisplay(issue.priority)
          } ${issue.identifier}: ${issue.title}`,
          value: issue.identifier,
        })),
        writer: Deno.stderr,
      })
      console.log(identifier)
    } catch (error) {
      handleError(error, "Failed to pick issue")
    }
  })
