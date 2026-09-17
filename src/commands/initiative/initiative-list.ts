import { Command } from "@cliffy/command"
import { unicodeWidth } from "@std/cli"
import { rgb24, underline } from "@std/fmt/colors"
import { open } from "@opensrc/deno-open"
import { gql } from "../../__codegen__/gql.ts"
import type { GetInitiativesQueryVariables } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { padDisplay, truncateText } from "../../utils/display.ts"
import { getWorkspaceUrl } from "../../utils/actions.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { handleError, NotFoundError } from "../../utils/errors.ts"
import { parseInitiativeStatus } from "./initiative-status.ts"

const GetInitiatives = gql(`
  query GetInitiatives($filter: InitiativeFilter, $includeArchived: Boolean) {
    initiatives(filter: $filter, includeArchived: $includeArchived) {
      nodes {
        id
        slugId
        name
        description
        status
        targetDate
        health
        color
        icon
        url
        archivedAt
        trashed
        owner {
          id
          displayName
          initials
        }
        projects {
          nodes {
            id
            name
            status {
              name
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`)

// Human display order; unlisted upstream statuses retain their original value.
const INITIATIVE_STATUS_ORDER: Record<string, number> = {
  "Active": 1,
  "Planned": 2,
  "Completed": 3,
}

export const listCommand = new Command()
  .name("list")
  .description("List initiatives")
  .option(
    "-s, --status <status:string>",
    "Filter by status (planned, active, completed, proposed, canceled)",
    { preserveEmpty: true },
  )
  .option("--all-statuses", "Show all statuses (default: active only)")
  .option(
    "-o, --owner <owner:string>",
    "Filter by owner (user UUID, username, name, email, 'self', or '@me')",
  )
  .option("-w, --web", "Open initiatives page in web browser")
  .option("-a, --app", "Open initiatives page in Linear.app")
  .option("-j, --json", "Output as JSON")
  .option("--archived", "Include archived and trashed initiatives")
  .action(async ({ status, allStatuses, owner, web, app, json, archived }) => {
    // Handle open in browser/app
    if (web || app) {
      const url = `${await getWorkspaceUrl()}/initiatives`
      const destination = app ? "Linear.app" : "web browser"
      console.log(`Opening ${url} in ${destination}`)
      await open(url, app ? { app: { name: "Linear" } } : undefined)
      return
    }

    const { Spinner } = await import("@std/cli/unstable-spinner")
    const showSpinner = shouldShowSpinner() && !json
    const spinner = showSpinner ? new Spinner() : null
    spinner?.start()

    try {
      // Build filter
      const filter: NonNullable<GetInitiativesQueryVariables["filter"]> = {}

      // Status filter
      if (status != null) {
        filter.status = { eq: parseInitiativeStatus(status) }
      } else if (!allStatuses) {
        // Default to active only
        filter.status = { eq: "Active" }
      }

      // Owner filter
      if (owner) {
        const { lookupUserId } = await import("../../utils/linear.ts")
        const ownerId = await lookupUserId(owner)
        if (!ownerId) {
          spinner?.stop()
          throw new NotFoundError("Owner", owner)
        }
        filter.owner = { id: { eq: ownerId } }
      }

      const client = getGraphQLClient()
      const result = await client.request(GetInitiatives, {
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        includeArchived: archived || false,
      })
      spinner?.stop()

      const initiativesConnection = result.initiatives ?? {
        nodes: [],
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
        },
      }

      let initiatives = initiativesConnection.nodes

      if (initiatives.length === 0) {
        if (json) {
          console.log(JSON.stringify(initiativesConnection, null, 2))
        } else {
          console.log("No initiatives found.")
        }
        return
      }

      // Sort initiatives by status then by name
      initiatives = initiatives.sort((a, b) => {
        const statusA = INITIATIVE_STATUS_ORDER[a.status] || 999
        const statusB = INITIATIVE_STATUS_ORDER[b.status] || 999

        if (statusA !== statusB) {
          return statusA - statusB
        }

        return a.name.localeCompare(b.name)
      })

      if (json) {
        console.log(JSON.stringify(
          {
            ...initiativesConnection,
            nodes: initiatives,
          },
          null,
          2,
        ))
        return
      }

      // Table output
      const { columns } = Deno.stdout.isTerminal()
        ? Deno.consoleSize()
        : { columns: 120 }

      // Calculate column widths
      const SLUG_WIDTH = Math.max(
        4,
        ...initiatives.map((init) => init.slugId.length),
      )
      const STATUS_WIDTH = Math.max(
        6,
        ...initiatives.map(
          (init) =>
            (init.status +
              (init.trashed
                ? " (trashed)"
                : init.archivedAt
                ? " (archived)"
                : "")).length,
        ),
      )
      const HEALTH_WIDTH = Math.max(
        6,
        ...initiatives.map((init) => (init.health || "-").length),
      )
      const OWNER_WIDTH = Math.max(
        5,
        ...initiatives.map((init) => (init.owner?.initials || "-").length),
      )
      const PROJECTS_WIDTH = Math.max(
        4,
        ...initiatives.map((init) =>
          String(init.projects?.nodes?.length || 0).length
        ),
      )
      const TARGET_WIDTH = Math.max(
        10,
        ...initiatives.map((init) => (init.targetDate || "-").length),
      )

      const SPACE_WIDTH = 6 // Space between columns
      const fixed = SLUG_WIDTH +
        STATUS_WIDTH +
        HEALTH_WIDTH +
        OWNER_WIDTH +
        PROJECTS_WIDTH +
        TARGET_WIDTH +
        SPACE_WIDTH
      const PADDING = 1
      const maxNameWidth = Math.max(
        ...initiatives.map((init) => unicodeWidth(init.name)),
      )
      const availableWidth = Math.max(columns - PADDING - fixed, 10)
      const nameWidth = Math.min(maxNameWidth, availableWidth)

      // Print header
      const headerCells = [
        padDisplay("SLUG", SLUG_WIDTH),
        padDisplay("NAME", nameWidth),
        padDisplay("STATUS", STATUS_WIDTH),
        padDisplay("HEALTH", HEALTH_WIDTH),
        padDisplay("OWNER", OWNER_WIDTH),
        padDisplay("PROJ", PROJECTS_WIDTH),
        padDisplay("TARGET", TARGET_WIDTH),
      ]

      console.log(underline(headerCells.join(" ")))

      // Print each initiative
      for (const init of initiatives) {
        const statusDisplay = init.status +
          (init.trashed ? " (trashed)" : init.archivedAt ? " (archived)" : "")
        const health = init.health || "-"
        const owner = init.owner?.initials || "-"
        const projectCount = String(init.projects?.nodes?.length || 0)
        const target = init.targetDate || "-"

        const truncName = truncateText(init.name, nameWidth)
        const paddedName = padDisplay(truncName, nameWidth)

        // Get status color
        const statusColors: Record<string, string> = {
          Active: "#27AE60",
          Planned: "#5E6AD2",
          Completed: "#6B6F76",
        }
        const statusColor = statusColors[init.status] || "#6B6F76"

        console.log(
          `${padDisplay(init.slugId, SLUG_WIDTH)} ${paddedName} ${
            rgb24(
              `${padDisplay(statusDisplay, STATUS_WIDTH)} ${
                padDisplay(health, HEALTH_WIDTH)
              } ${padDisplay(owner, OWNER_WIDTH)} ${
                padDisplay(projectCount, PROJECTS_WIDTH)
              } `,
              parseInt(statusColor.replace("#", ""), 16),
            )
          }${rgb24(padDisplay(target, TARGET_WIDTH), 0x808080)}`,
        )
      }
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to fetch initiatives")
    }
  })
