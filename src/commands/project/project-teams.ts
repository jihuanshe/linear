import { Command } from "@cliffy/command"
import { resolveProjectId } from "../../utils/linear.ts"
import { getProjectTeams } from "../../utils/project-teams.ts"
import { handleError } from "../../utils/errors.ts"

export const teamsCommand = new Command()
  .name("teams")
  .description(
    "List all teams eligible for a project (UUID, slug ID, or exact name)",
  )
  .arguments("<project:string>")
  .option(
    "--json",
    "Output project identity and the complete teams connection as JSON",
  )
  .action(async (options, project) => {
    try {
      const result = await getProjectTeams(await resolveProjectId(project))
      if (options.json) console.log(JSON.stringify(result, null, 2))
      else {console.log(
          result.teams.nodes.map((team) => `${team.key}\t${team.name}`).join(
            "\n",
          ),
        )}
    } catch (error) {
      handleError(error, "Failed to list project teams")
    }
  })
