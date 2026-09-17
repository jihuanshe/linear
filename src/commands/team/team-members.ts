import { Command } from "@cliffy/command"
import { getTeamKey, getTeamMembers } from "../../utils/linear.ts"
import { printMembers } from "../../utils/member-display.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export const membersCommand = new Command()
  .name("members")
  .description(
    "List members of a team by UUID or key; uses the configured default team when omitted",
  )
  .arguments("[team:string]")
  .option("-a, --all", "Include inactive members")
  .option(
    "-j, --json",
    "Output as JSON; use each member's url for Markdown mentions",
  )
  .action(async ({ all, json }, teamReference?: string) => {
    const showSpinner = !json && shouldShowSpinner()
    let spinner: { start: () => void; stop: () => void } | null = null

    try {
      const selectedTeam = teamReference || getTeamKey()
      if (!selectedTeam) {
        throw new ValidationError(
          "No default team configured",
          {
            suggestion:
              "Specify a team UUID or key as an argument, or run `linear config` to set a default team.",
          },
        )
      }

      if (showSpinner) {
        const { Spinner } = await import("@std/cli/unstable-spinner")
        spinner = new Spinner()
        spinner.start()
      }

      const includeDisabled = all === true
      const { nodes, pageInfo } = await getTeamMembers(
        selectedTeam,
        includeDisabled,
      )

      spinner?.stop()

      // --json is an output format, not a raw dump: it must respect --all just
      // as the human output does.
      const members = includeDisabled
        ? nodes
        : nodes.filter((member) => member.active)

      if (json) {
        console.log(JSON.stringify({ nodes: members, pageInfo }, null, 2))
        return
      }

      if (nodes.length === 0) {
        console.log("No members found for this team.")
        return
      }

      if (members.length === 0) {
        console.log(
          "No active members found for this team. Use --all to include inactive members.",
        )
        return
      }

      printMembers(members, "Team Members")
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to fetch team members")
    }
  })
