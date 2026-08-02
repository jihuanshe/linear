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
  .option("--dry-run", "Show planned changes without deleting the team")
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

      // If the team has issues, require --move-issues or prompt
      if (issueCount > 0 && !moveIssues) {
        console.log(
          `\n⚠️  Team ${team.key} (${team.name}) has ${issueCount} issue(s).`,
        )
        console.log(
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
      } else if (issueCount > 0 && moveIssues) {
        // Resolve the target team
        targetTeamId = await getTeamIdByKey(moveIssues.toUpperCase())
        if (!targetTeamId) {
          throw new NotFoundError("Target team", moveIssues)
        }

        if (targetTeamId === teamId) {
          throw new ValidationError("Cannot move issues to the same team")
        }
        targetTeamDisplay = moveIssues.toUpperCase()
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

      if (targetTeamId) {
        await moveIssuesToTeam(client, teamId, targetTeamId, issueCount)
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
  // deno-lint-ignore no-explicit-any
  client: any,
  sourceTeamId: string,
  targetTeamId: string,
  issueCount: number,
) {
  const { Spinner } = await import("@std/cli/unstable-spinner")
  const { shouldShowSpinner } = await import("../../utils/hyperlink.ts")
  const spinner = shouldShowSpinner()
    ? new Spinner({
      message: `Moving ${issueCount} issue(s) to target team...`,
    })
    : null
  spinner?.start()

  try {
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

    // Update each issue to move to target team
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

    const movedIssues: Array<{ from: string; to: string }> = []
    let movedCount = 0
    for (const issue of allIssues) {
      const result = await client.request(updateIssueMutation, {
        id: issue.id,
        teamId: targetTeamId,
      })
      if (!result.issueUpdate.success || !result.issueUpdate.issue) {
        throw new CliError(`Failed to move issue ${issue.identifier}`)
      }
      movedIssues.push({
        from: issue.identifier,
        to: result.issueUpdate.issue.identifier,
      })
      movedCount++
      if (spinner) {
        spinner.message = `Moving issues... (${movedCount}/${allIssues.length})`
      }
    }

    spinner?.stop()
    for (const issue of movedIssues) {
      console.log(`✓ Moved ${issue.from} → ${issue.to}`)
    }
    console.log(`✓ Moved ${movedCount} issue(s) to target team`)
  } catch (error) {
    spinner?.stop()
    handleError(error, "Failed to move issues")
  }
}
