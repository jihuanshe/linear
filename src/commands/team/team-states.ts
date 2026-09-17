import { Command } from "@cliffy/command"
import { unicodeWidth } from "@std/cli"
import { underline } from "@std/fmt/colors"
import { getTeamKey, getWorkflowStates } from "../../utils/linear.ts"
import { padDisplay } from "../../utils/display.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export const statesCommand = new Command()
  .name("states")
  .description(
    "List workflow states for a team by UUID or key; uses the configured default team when omitted",
  )
  .arguments("[team:string]")
  .option("-j, --json", "Output as JSON")
  .action(async ({ json }, teamReference?: string) => {
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

      const states = await getWorkflowStates(selectedTeam)

      spinner?.stop()

      if (json) {
        console.log(JSON.stringify({ nodes: states }, null, 2))
        return
      }

      if (states.length === 0) {
        console.log("No workflow states found for this team.")
        return
      }

      // States arrive sorted by position; keep that order (it is meaningful).
      const NAME_WIDTH = Math.max(
        unicodeWidth("NAME"),
        ...states.map((s) => unicodeWidth(s.name)),
      )
      const TYPE_WIDTH = Math.max(
        unicodeWidth("TYPE"),
        ...states.map((s) => unicodeWidth(s.type)),
      )

      console.log(
        underline(
          `${padDisplay("NAME", NAME_WIDTH)} ${padDisplay("TYPE", TYPE_WIDTH)}`,
        ),
      )

      for (const state of states) {
        console.log(
          `${padDisplay(state.name, NAME_WIDTH)} ${
            padDisplay(state.type, TYPE_WIDTH)
          }`,
        )
      }
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to fetch workflow states")
    }
  })
