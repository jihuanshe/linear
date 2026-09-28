import { Command } from "@cliffy/command"
import { unicodeWidth } from "@std/cli"
import { rgb24, underline } from "@std/fmt/colors"
import { open } from "@opensrc/deno-open"
import { gql } from "../../__codegen__/gql.ts"
import type { GetTeamsQuery } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getTimeAgo, padDisplay, truncateText } from "../../utils/display.ts"
import { getWorkspaceUrl } from "../../utils/actions.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { handleError } from "../../utils/errors.ts"
import { limitType, warnIfTruncated } from "../../utils/pagination.ts"

const GetTeams = gql(`
  query GetTeams($filter: TeamFilter, $first: Int, $after: String) {
    teams(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        name
        key
        description
        icon
        color
        cyclesEnabled
        createdAt
        updatedAt
        archivedAt
        organization {
          id
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`)

export const listCommand = new Command()
  .name("list")
  .description("List teams")
  .option("-w, --web", "Open in web browser")
  .option("-a, --app", "Open in Linear.app")
  .option("-j, --json", "Output as JSON")
  .type("limit", limitType)
  .option(
    "--limit <limit:limit>",
    "Maximum teams to read (0 or omitted reads all pages); human and JSON output select the same teams",
  )
  .action(async ({ web, app, json, limit }) => {
    const { Spinner } = await import("@std/cli/unstable-spinner")
    const showSpinner = shouldShowSpinner() && !json
    const spinner = showSpinner ? new Spinner() : null

    try {
      if (web || app) {
        const url = `${await getWorkspaceUrl()}/settings/teams`
        const destination = app ? "Linear.app" : "web browser"
        console.log(`Opening ${url} in ${destination}`)
        await open(url, app ? { app: { name: "Linear" } } : undefined)
        return
      }

      spinner?.start()

      const client = getGraphQLClient()
      // Human and JSON output must select the same teams for one --limit;
      // the name sort below only orders what was read.
      const bounded = limit != null && limit > 0

      // Fetch all teams with pagination
      const allTeams: GetTeamsQuery["teams"]["nodes"] = []
      let hasNextPage = true
      let after: string | null | undefined = undefined
      let pageInfo: NonNullable<GetTeamsQuery["teams"]>["pageInfo"] = {
        hasNextPage: false,
        endCursor: null,
      }

      while (hasNextPage) {
        const activeTeamCount = allTeams.filter((team) =>
          !team.archivedAt
        ).length
        const first = bounded ? Math.min(100, limit - activeTeamCount) : 100
        const result: GetTeamsQuery = await client.request(GetTeams, {
          filter: undefined,
          first,
          after,
        })

        const teams = result.teams?.nodes || []
        allTeams.push(...teams)

        pageInfo = result.teams?.pageInfo ?? {
          hasNextPage: false,
          endCursor: null,
        }
        hasNextPage = pageInfo.hasNextPage
        after = pageInfo.endCursor
        if (bounded) {
          const activeTeams = allTeams.filter((team) => !team.archivedAt)
          if (activeTeams.length >= limit) break
        }
      }

      spinner?.stop()

      // Filter out archived teams
      // Sort teams alphabetically by name
      const teams = allTeams.filter((team) => !team.archivedAt)
        .sort((a, b) => a.name.localeCompare(b.name))

      if (json) {
        console.log(JSON.stringify({ nodes: teams, pageInfo }, null, 2))
        return
      }

      if (teams.length === 0) {
        console.log("No teams found.")
        return
      }

      // Define column widths based on actual data
      const { columns } = Deno.stdout.isTerminal()
        ? Deno.consoleSize()
        : { columns: 120 }
      const ID_WIDTH = Math.max(
        2, // minimum width for "ID" header
        ...teams.map((team) => team.id.length),
      )
      const KEY_WIDTH = Math.max(
        3, // minimum width for "KEY" header
        ...teams.map((team) => team.key.length),
      )
      const CYCLES_WIDTH = Math.max(
        6, // minimum width for "CYCLES" header
        3, // "Yes" or "No"
      )
      const UPDATED_WIDTH = Math.max(
        7, // minimum width for "UPDATED" header
        ...teams.map((team) => getTimeAgo(new Date(team.updatedAt)).length),
      )

      const SPACE_WIDTH = 5
      const fixed = ID_WIDTH + KEY_WIDTH + CYCLES_WIDTH + UPDATED_WIDTH +
        SPACE_WIDTH
      const PADDING = 1
      const maxNameWidth = Math.max(
        ...teams.map((team) => unicodeWidth(team.name)),
      )
      const availableWidth = Math.max(columns - PADDING - fixed, 0)
      const nameWidth = Math.min(maxNameWidth, availableWidth)

      // Print header
      const headerCells = [
        padDisplay("KEY", KEY_WIDTH),
        padDisplay("NAME", nameWidth),
        padDisplay("CYCLES", CYCLES_WIDTH),
        padDisplay("UPDATED", UPDATED_WIDTH),
        padDisplay("ID", ID_WIDTH),
      ]

      console.log(underline(headerCells.join(" ")))

      // Print each team
      for (const team of teams) {
        const cycles = team.cyclesEnabled ? "Yes" : "No"
        const updated = getTimeAgo(new Date(team.updatedAt))

        const truncName = padDisplay(
          truncateText(team.name, nameWidth),
          nameWidth,
        )

        console.log(
          `${
            rgb24(
              `${padDisplay(team.key, KEY_WIDTH)} ${truncName} ${
                padDisplay(cycles, CYCLES_WIDTH)
              } `,
              parseInt((team.color || "#ffffff").replace("#", ""), 16),
            )
          }${
            rgb24(
              `${padDisplay(updated, UPDATED_WIDTH)} ${
                padDisplay(team.id, ID_WIDTH)
              }`,
              0x808080,
            )
          }`,
        )
      }
      warnIfTruncated({ nodes: teams, pageInfo }, "team", "teams")
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to fetch teams")
    }
  })
