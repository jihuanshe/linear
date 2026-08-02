import { Command } from "@cliffy/command"
import { assertPromptAllowed, Confirm, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getAllTeams, getTeamIdByKey } from "../../utils/linear.ts"
import {
  CliError,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

const GetTeamIssuesForMove = gql(`
  query GetTeamIssuesForMove($teamId: String!, $first: Int, $after: String) {
    team(id: $teamId) {
      issues(first: $first, after: $after) {
        nodes {
          id
          identifier
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`)

export const deleteCommand = new Command()
  .name("delete")
  .description("Delete a Linear team")
  .arguments("<teamKey:string>")
  .option(
    "--move-issues <targetTeam:string>",
    "Move all issues to another team before deletion",
  )
  .option("-y, --force", "Skip confirmation prompt")
  .option(
    "--dry-run",
    "Validate and show planned changes without prompting or mutating",
  )
  .action(async ({ moveIssues, force, dryRun }, teamKey) => {
    try {
      const client = getGraphQLClient()

      // Resolve the team ID from the key
      const teamId = await getTeamIdByKey(teamKey.toUpperCase())
      if (!teamId) {
        throw new NotFoundError("Team", teamKey)
      }

      // Get team details for confirmation message
      const teamDetailsQuery = gql(`
        query GetTeamDetails($id: String!) {
          team(id: $id) {
            id
            key
            name
            issueCount
          }
        }
      `)

      const teamDetails = await client.request(teamDetailsQuery, { id: teamId })

      if (!teamDetails?.team) {
        throw new NotFoundError("Team", teamKey)
      }

      const team = teamDetails.team
      const issueCount = team.issueCount
      let targetTeamId: string | undefined
      let targetTeamDisplay: string | undefined

      // An explicit target must always be valid, even when there are no issues.
      if (moveIssues) {
        targetTeamId = await getTeamIdByKey(moveIssues.toUpperCase())
        if (!targetTeamId) {
          throw new NotFoundError("Target team", moveIssues)
        }

        if (targetTeamId === teamId) {
          throw new ValidationError("Cannot move issues to the same team")
        }
        targetTeamDisplay = moveIssues.toUpperCase()
      }

      // A dry run must never prompt and should predict whether the same
      // non-interactive invocation has enough information to run.
      if (dryRun && issueCount > 0 && !targetTeamId) {
        throw new ValidationError(
          `Team ${team.key} has ${issueCount} issue(s) that must be moved before deletion`,
          {
            suggestion:
              "Use --move-issues <teamKey> to specify the target team.",
          },
        )
      }

      // If the team has issues, require --move-issues or prompt.
      if (issueCount > 0 && !targetTeamId) {
        console.error(
          `\n⚠️  Team ${team.key} (${team.name}) has ${issueCount} issue(s).`,
        )
        console.error(
          "You must move these issues to another team before deletion.\n",
        )

        assertPromptAllowed({
          suggestion: "Use --move-issues <teamKey> to specify the target team.",
        })

        const allTeams = await getAllTeams()
        const otherTeams = allTeams.filter((t) => t.id !== teamId)

        if (otherTeams.length === 0) {
          throw new CliError("No other teams available to move issues to")
        }

        targetTeamId = await Select.prompt({
          message: "Select a team to move issues to:",
          options: otherTeams.map((t) => ({
            name: `${t.name} (${t.key})`,
            value: t.id,
          })),
        })
        const targetTeam = otherTeams.find((team) => team.id === targetTeamId)
        if (targetTeam) {
          targetTeamDisplay = `${targetTeam.key} (${targetTeam.name})`
        }
      }

      if (dryRun) {
        console.log(`Would delete team ${team.key} (${team.name})`)
        if (targetTeamId) {
          console.log(
            `Would move ${issueCount} issue(s) to ${targetTeamDisplay}`,
          )
        }
        return
      }

      // Confirm deletion
      if (!force) {
        assertPromptAllowed({
          suggestion: "Use --force to skip the confirmation prompt.",
        })
        const confirmed = await Confirm.prompt({
          message:
            `Are you sure you want to delete team "${team.key}: ${team.name}"?`,
          default: false,
        })

        if (!confirmed) {
          console.log("Delete cancelled.")
          return
        }
      }

      if (targetTeamId && issueCount > 0) {
        await moveIssuesToTeam(client, teamId, targetTeamId)
      }

      // Delete the team
      const deleteTeamMutation = gql(`
        mutation DeleteTeam($id: String!) {
          teamDelete(id: $id) {
            success
          }
        }
      `)

      const result = await client.request(deleteTeamMutation, { id: teamId })

      if (result.teamDelete.success) {
        console.log(`✓ Successfully deleted team: ${team.key}: ${team.name}`)
      } else {
        throw new CliError("Failed to delete team")
      }
    } catch (error) {
      handleError(error, "Failed to delete team")
    }
  })

async function moveIssuesToTeam(
  client: ReturnType<typeof getGraphQLClient>,
  sourceTeamId: string,
  targetTeamId: string,
) {
  // Fetch all issues from source team
  type IssueNode = { id: string; identifier: string }
  type PageInfo = { hasNextPage: boolean; endCursor?: string | null }
  type TeamIssuesResult = {
    team?: {
      issues?: {
        nodes?: IssueNode[]
        pageInfo?: PageInfo
      } | null
    } | null
  }

  const allIssues: IssueNode[] = []
  let hasNextPage = true
  let after: string | undefined = undefined

  while (hasNextPage) {
    const result: TeamIssuesResult = await client.request(
      GetTeamIssuesForMove,
      {
        teamId: sourceTeamId,
        first: 100,
        after,
      },
    )

    const issues = result.team?.issues?.nodes || []
    allIssues.push(...issues)

    hasNextPage = result.team?.issues?.pageInfo?.hasNextPage || false
    after = result.team?.issues?.pageInfo?.endCursor ?? undefined
  }

  // Update each issue to move to target team. Print each mapping as soon as it
  // becomes durable so a later failure cannot hide already-changed identifiers.
  const updateIssueMutation = gql(`
    mutation MoveIssueToTeam($id: String!, $teamId: String!) {
      issueUpdate(id: $id, input: { teamId: $teamId }) {
        success
        issue {
          identifier
        }
      }
    }
  `)

  let movedCount = 0
  for (const issue of allIssues) {
    const result = await client.request(updateIssueMutation, {
      id: issue.id,
      teamId: targetTeamId,
    })
    if (!result.issueUpdate.success || !result.issueUpdate.issue) {
      throw new CliError(`Failed to move issue ${issue.identifier}`)
    }
    console.log(
      `✓ Moved ${issue.identifier} → ${result.issueUpdate.issue.identifier}`,
    )
    movedCount++
  }
  console.log(`✓ Moved ${movedCount} issue(s) to target team`)
}
