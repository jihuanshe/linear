import { Command } from "@cliffy/command"
import { green, red, rgb24, underline, yellow } from "@std/fmt/colors"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getTimeAgo, padDisplay, truncateText } from "../../utils/display.ts"
import { resolveProjectId } from "../../utils/linear.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

const ListProjectUpdatesQuery = gql(`
  query ListProjectUpdates($id: String!, $first: Int) {
    project(id: $id) {
      name
      slugId
      projectUpdates(first: $first) {
        nodes {
          id
          body
          health
          url
          createdAt
          user {
            name
            displayName
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

export const listCommand = new Command()
  .name("list")
  .description(
    "List status updates for a project by UUID, slug ID, or exact name",
  )
  .alias("l")
  .arguments("<project:string>")
  .option("--json", "Output as JSON")
  .option("--limit <limit:number>", "Maximum results (positive integer)", {
    default: 10,
  })
  .action(async ({ json, limit }, projectReference) => {
    const { Spinner } = await import("@std/cli/unstable-spinner")
    const showSpinner = shouldShowSpinner() && !json
    const spinner = showSpinner ? new Spinner() : null
    spinner?.start()

    try {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new ValidationError("--limit must be a positive integer")
      }

      // Resolve project ID
      const resolvedProjectId = await resolveProjectId(projectReference)

      const client = getGraphQLClient()
      const result = await client.request(ListProjectUpdatesQuery, {
        id: resolvedProjectId,
        first: limit,
      })
      spinner?.stop()

      const project = result.project
      if (!project) {
        throw new NotFoundError("Project", projectReference)
      }

      const updates = project.projectUpdates?.nodes || []

      if (json) {
        console.log(JSON.stringify(project, null, 2))
        return
      }

      if (updates.length === 0) {
        console.log(`No status updates found for project: ${project.name}`)
        return
      }

      console.log(`Status updates for: ${project.name}`)
      console.log("")

      // Calculate column widths based on actual data
      const { columns } = Deno.stdout.isTerminal()
        ? Deno.consoleSize()
        : { columns: 120 }

      const ID_WIDTH = 8 // Short ID prefix

      const HEALTH_WIDTH = Math.max(
        6, // minimum width for "HEALTH" header
        ...updates.map((u) => (u.health || "-").length),
      )

      const DATE_WIDTH = Math.max(
        4, // minimum width for "DATE" header
        ...updates.map((u) => getTimeAgo(new Date(u.createdAt)).length),
      )

      // Get author display name
      const getAuthor = (update: typeof updates[0]) => {
        if (update.user?.displayName) return update.user.displayName
        if (update.user?.name) return update.user.name
        return "-"
      }

      const AUTHOR_WIDTH = Math.max(
        6, // minimum width for "AUTHOR" header
        ...updates.map((u) => getAuthor(u).length),
      )

      const SPACE_WIDTH = 4 // spaces between columns
      const fixed = ID_WIDTH + HEALTH_WIDTH + DATE_WIDTH + AUTHOR_WIDTH +
        SPACE_WIDTH
      const PADDING = 1
      const availableWidth = Math.max(columns - PADDING - fixed, 10)

      // Print header
      const header = [
        padDisplay("ID", ID_WIDTH),
        padDisplay("HEALTH", HEALTH_WIDTH),
        padDisplay("DATE", DATE_WIDTH),
        padDisplay("AUTHOR", AUTHOR_WIDTH),
      ]

      console.log(underline(header.join(" ")))

      // Print each update
      for (const update of updates) {
        const shortId = update.id.slice(0, 8)
        const health = update.health || "-"
        const date = getTimeAgo(new Date(update.createdAt))
        const author = getAuthor(update)

        let details = `${padDisplay(health, HEALTH_WIDTH)} ${
          padDisplay(date, DATE_WIDTH)
        } ${padDisplay(author, AUTHOR_WIDTH)}`
        if (update.health === "onTrack") {
          details = green(details)
        } else if (update.health === "atRisk") {
          details = yellow(details)
        } else if (update.health === "offTrack") {
          details = red(details)
        }

        console.log(`${padDisplay(shortId, ID_WIDTH)} ${details}`)

        // Show truncated body if available
        if (update.body) {
          const bodyPreview = update.body.replace(/\n/g, " ").trim()
          const truncatedBody = truncateText(bodyPreview, availableWidth)
          console.log(rgb24(`   ${truncatedBody}`, 0x808080))
        }
      }
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to fetch project updates")
    }
  })
