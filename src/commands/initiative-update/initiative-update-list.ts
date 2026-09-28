import { Command } from "@cliffy/command"
import { rgb24, underline } from "@std/fmt/colors"
import { gql } from "../../__codegen__/gql.ts"
import {
  formatRelativeTime,
  padDisplay,
  truncateText,
} from "../../utils/display.ts"
import { handleError, NotFoundError } from "../../utils/errors.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  completeConnection,
  limitType,
  warnIfTruncated,
} from "../../utils/pagination.ts"
import { resolveInitiativeId } from "../initiative/initiative-resolve.ts"

// Health display colors
const HEALTH_COLORS: Record<string, string> = {
  onTrack: "#27AE60",
  atRisk: "#F2994A",
  offTrack: "#EB5757",
}

const HEALTH_DISPLAY: Record<string, string> = {
  onTrack: "On Track",
  atRisk: "At Risk",
  offTrack: "Off Track",
}

export const listCommand = new Command()
  .name("list")
  .description(
    "List status updates for an initiative by UUID, slug ID, name, or Linear URL",
  )
  .alias("l")
  .arguments("<initiative:string>")
  .option(
    "-j, --json",
    "Output {name, slugId, initiativeUpdates: {nodes, pageInfo}}; pageInfo.hasNextPage is true when --limit left more updates",
  )
  .type("limit", limitType)
  .option(
    "--limit <limit:limit>",
    "Maximum number of updates (use 0 for all pages)",
    { default: 10 },
  )
  .action(async ({ json, limit }, initiativeReference) => {
    const { Spinner } = await import("@std/cli/unstable-spinner")
    const showSpinner = shouldShowSpinner() && !json
    const spinner = showSpinner ? new Spinner() : null
    spinner?.start()

    try {
      const client = getGraphQLClient()

      // Resolve initiative ID
      const resolvedId = await resolveInitiativeId(client, initiativeReference)

      const listQuery = gql(`
        query ListInitiativeUpdates($id: String!, $first: Int, $after: String) {
          initiative(id: $id) {
            name
            slugId
            initiativeUpdates(first: $first, after: $after) {
              nodes {
                id
                body
                health
                url
                createdAt
                user {
                  name
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `)

      const fetchInitiative = async (
        after?: string,
        first = limit > 0 ? Math.min(100, limit) : 100,
      ) => {
        const result = await client.request(listQuery, {
          id: resolvedId,
          first,
          after,
        })
        if (!result.initiative) {
          throw new NotFoundError("Initiative", initiativeReference)
        }
        return result.initiative
      }
      const initiative = await fetchInitiative()
      initiative.initiativeUpdates = await completeConnection(
        initiative.initiativeUpdates,
        async (after, first) =>
          (await fetchInitiative(after, first)).initiativeUpdates,
        `updates for initiative ${resolvedId}`,
        limit,
      )
      spinner?.stop()

      const updates = initiative.initiativeUpdates.nodes

      if (json) {
        console.log(JSON.stringify(initiative, null, 2))
        return
      }

      if (updates.length === 0) {
        console.log(`No status updates found for: ${initiative.name}`)
        return
      }

      console.log(`Status updates for: ${initiative.name}\n`)

      // Calculate column widths
      const { columns } = Deno.stdout.isTerminal()
        ? Deno.consoleSize()
        : { columns: 120 }

      // ID column - show first 8 chars of UUID
      const ID_WIDTH = 8

      // Health column
      const HEALTH_WIDTH = Math.max(
        6,
        ...updates.map((u) =>
          u.health ? (HEALTH_DISPLAY[u.health] || u.health).length : 1
        ),
      )

      // Date column
      const DATE_WIDTH = Math.max(
        4,
        ...updates.map((u) => formatRelativeTime(u.createdAt).length),
      )

      // Author column
      const AUTHOR_WIDTH = Math.max(
        6,
        ...updates.map((u) => (u.user?.name || "-").length),
      )

      const SPACE_WIDTH = 4 // spaces between columns
      const fixed = ID_WIDTH + HEALTH_WIDTH + DATE_WIDTH + AUTHOR_WIDTH +
        SPACE_WIDTH
      const PADDING = 1
      const availableWidth = Math.max(columns - PADDING - fixed, 10)

      // Print header
      const headerCells = [
        padDisplay("ID", ID_WIDTH),
        padDisplay("HEALTH", HEALTH_WIDTH),
        padDisplay("DATE", DATE_WIDTH),
        padDisplay("AUTHOR", AUTHOR_WIDTH),
      ]

      console.log(underline(headerCells.join(" ")))

      // Print each update
      for (const update of updates) {
        const shortId = update.id.slice(0, 8)
        const healthDisplay = update.health
          ? (HEALTH_DISPLAY[update.health] || update.health)
          : "-"
        const healthColor = update.health
          ? (HEALTH_COLORS[update.health] || "#6B6F76")
          : "#6B6F76"
        const date = formatRelativeTime(update.createdAt)
        const author = update.user?.name || "-"

        console.log(
          `${padDisplay(shortId, ID_WIDTH)} ${
            rgb24(
              `${padDisplay(healthDisplay, HEALTH_WIDTH)} `,
              parseInt(healthColor.replace("#", ""), 16),
            )
          }${
            rgb24(
              `${padDisplay(date, DATE_WIDTH)} ${
                padDisplay(author, AUTHOR_WIDTH)
              }`,
              0x808080,
            )
          }`,
        )

        // Print body preview if available (indented, on next line)
        if (update.body) {
          const bodyPreview = truncateText(
            update.body.replace(/\n/g, " ").trim(),
            availableWidth,
          )
          console.log(`  ${rgb24(bodyPreview, 0x808080)}`)
        }
      }
      warnIfTruncated(initiative.initiativeUpdates, "update", "updates")
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to fetch initiative updates")
    }
  })
