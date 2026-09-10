import { Command } from "@cliffy/command"
import { getTeamKey } from "../../utils/linear.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

export const keyCommand = new Command()
  .name("key")
  .description(
    "Print the configured team key; team list --json includes team UUIDs",
  )
  .action(() => {
    try {
      const teamKey = getTeamKey()
      if (teamKey) {
        console.log(teamKey)
      } else {
        throw new ValidationError(
          "No team key configured",
          { suggestion: "Run `linear config` to set a team." },
        )
      }
    } catch (error) {
      handleError(error, "Failed to get team key")
    }
  })
