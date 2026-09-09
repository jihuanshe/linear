import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { assertPromptAllowed, Confirm } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getTeamIdByKey } from "../../utils/linear.ts"
import {
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

const GetTeamDetails = gql(`
  query GetTeamDetails($id: String!) {
    team(id: $id) { id key name issueCount(includeArchived: true) }
  }
`)
const DeleteTeam = gql(`
  mutation DeleteTeam($id: String!) {
    teamDelete(id: $id) { success }
  }
`)

export const deleteCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--force",
})
  .name("delete")
  .description(
    "Delete an empty Linear team; migrate issues separately before deletion",
  )
  .arguments("<teamKey:string>")
  .option("-y, --force", "Skip confirmation prompt")
  .option("--dry-run", "Validate without prompting or mutating")
  .option("--json", "Output the deletion result as JSON")
  .action(async ({ force, dryRun, json }, teamKey) => {
    try {
      const client = getGraphQLClient()
      const teamId = await getTeamIdByKey(teamKey.toUpperCase())
      if (!teamId) throw new NotFoundError("Team", teamKey)
      const readEmptyTeam = async () => {
        const { team } = await client.request(GetTeamDetails, { id: teamId })
        if (!team) throw new NotFoundError("Team", teamKey)
        if (team.issueCount !== 0) {
          throw new ValidationError(
            `Team ${team.key} has ${team.issueCount} issue(s); deletion requires an empty team`,
            {
              suggestion:
                "Use recipes/migrate-team.js to freeze and migrate an explicit issue set, then inspect the team before deleting it.",
            },
          )
        }
        return team
      }
      const team = await readEmptyTeam()
      if (dryRun) {
        if (json) printWriteResult({ team, dryRun: true }, { effect: "none" })
        else console.log(`Would delete team ${team.key} (${team.name})`)
        return
      }
      if (!force) {
        assertPromptAllowed({
          suggestion: "Use --force to skip the confirmation prompt.",
        })
        if (
          !await Confirm.prompt({
            message: `Delete team "${team.key}: ${team.name}"?`,
            default: false,
            writer: Deno.stderr,
          })
        ) {
          if (json) {
            printWriteResult({ team, cancelled: true }, { effect: "none" })
          } else console.log("Delete cancelled.")
          return
        }
      }
      // Recheck after the user decision; this is an observation, not a server lock.
      await readEmptyTeam()
      const result = await client.request(DeleteTeam, { id: teamId })
      assertMutationSuccess(result?.teamDelete, result)
      if (json) printWriteResult({ ...result.teamDelete, team })
      else console.log(`✓ Successfully deleted team: ${team.key}: ${team.name}`)
    } catch (error) {
      handleError(error, "Failed to delete team")
    }
  })
