import { Command } from "@cliffy/command"
import { unicodeWidth } from "@std/cli"
import { rgb24, underline } from "@std/fmt/colors"
import { open } from "@opensrc/deno-open"
import { gql } from "../../__codegen__/gql.ts"
import type {
  GetProjectsQuery,
  ProjectStatusType,
} from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getTimeAgo, padDisplay } from "../../utils/display.ts"
import { getWorkspaceUrl } from "../../utils/actions.ts"
import { getTeamKey } from "../../utils/linear.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"

const GetProjects = gql(`
  query GetProjects($filter: ProjectFilter, $first: Int, $after: String) {
    projects(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        name
        description
        slugId
        icon
        color
        status {
          id
          name
          color
          type
        }
        lead {
          name
          displayName
          initials
        }
        priority
        health
        startDate
        targetDate
        startedAt
        completedAt
        canceledAt
        createdAt
        updatedAt
        url
        teams {
          nodes {
            key
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

export const listCommand = new Command()
  .name("list")
  .description("List projects")
  .option("--team <key:string>", "Filter by team key")
  .option("--all-teams", "Show projects from all teams")
  .option("--status-name <name:string>", "Filter by exact status name")
  .option("-w, --web", "Open in web browser")
  .option("-a, --app", "Open in Linear.app")
  .option("-j, --json", "Output as JSON")
  .option(
    "--limit <limit:number>",
    "Maximum results (non-negative integer; 0 or omitted means unlimited)",
  )
  .action(async ({ team, allTeams, statusName, web, app, json, limit }) => {
    if (web || app) {
      const workspaceUrl = await getWorkspaceUrl()

      // Determine team to filter by for URL construction
      const teamKey = allTeams ? null : (team?.toUpperCase() || getTeamKey())
      const url = teamKey
        ? `${workspaceUrl}/team/${teamKey}/projects/all`
        : `${workspaceUrl}/projects/all`
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
      if (limit != null && (!Number.isSafeInteger(limit) || limit < 0)) {
        throw new ValidationError("--limit must be a non-negative integer")
      }

      // Validate conflicting flags
      if (team && allTeams) {
        throw new ValidationError(
          "Cannot use both --team and --all-teams flags",
        )
      }

      // Determine team to filter by
      const teamKey = allTeams ? null : (team?.toUpperCase() || getTeamKey())

      let filter = {}
      if (teamKey) {
        filter = {
          ...filter,
          accessibleTeams: { some: { key: { eq: teamKey } } },
        }
      }
      if (statusName) {
        filter = { ...filter, status: { name: { eq: statusName } } }
      }

      const client = getGraphQLClient()
      const boundedJson = json && limit != null && limit > 0

      // Fetch all projects with pagination
      const allProjects: GetProjectsQuery["projects"]["nodes"] = []
      let hasNextPage = true
      let after: string | null | undefined = undefined
      let pageInfo: NonNullable<GetProjectsQuery["projects"]>["pageInfo"] = {
        hasNextPage: false,
        endCursor: null,
      }

      while (hasNextPage) {
        const first = boundedJson
          ? Math.min(100, limit - allProjects.length)
          : 100
        const result: GetProjectsQuery = await client.request(GetProjects, {
          filter: Object.keys(filter).length > 0 ? filter : undefined,
          first,
          after,
        })

        const projectsConnection = result.projects
        const projects = projectsConnection?.nodes || []
        allProjects.push(...projects)

        pageInfo = projectsConnection?.pageInfo ?? {
          hasNextPage: false,
          endCursor: null,
        }
        hasNextPage = pageInfo.hasNextPage
        after = pageInfo.endCursor
        if (boundedJson && allProjects.length >= limit) break
      }

      spinner?.stop()

      type Project = GetProjectsQuery["projects"]["nodes"][number]
      let projects: Project[] = allProjects

      if (projects.length === 0) {
        if (json) {
          console.log(JSON.stringify(
            {
              nodes: allProjects,
              pageInfo,
            },
            null,
            2,
          ))
        } else {
          console.log("No projects found.")
        }
        return
      }

      if (!boundedJson) {
        // Sort projects logically by status then by relevant date
        const statusOrder: Record<ProjectStatusType, number> = {
          "started": 1,
          "planned": 2,
          "backlog": 3,
          "paused": 4,
          "completed": 5,
          "canceled": 6,
        }

        projects = projects.sort((a, b) => {
          // First sort by status type priority
          const statusA =
            statusOrder[a.status.type as keyof typeof statusOrder] || 999
          const statusB =
            statusOrder[b.status.type as keyof typeof statusOrder] || 999

          if (statusA !== statusB) {
            return statusA - statusB
          }

          // Then sort alphabetically by name
          return a.name.localeCompare(b.name)
        })

        if (limit != null && limit > 0) {
          projects = projects.slice(0, limit)
        }
      }

      if (json) {
        console.log(JSON.stringify(
          {
            nodes: projects,
            pageInfo,
          },
          null,
          2,
        ))
        return
      }

      // Helper function to get the most relevant date to display
      const getDisplayDate = (
        project: GetProjectsQuery["projects"]["nodes"][0],
      ) => {
        switch (project.status.type) {
          case "started":
            return project.startedAt
              ? `Started ${getTimeAgo(new Date(project.startedAt))}`
              : project.startDate
              ? `Start: ${project.startDate}`
              : `Created ${getTimeAgo(new Date(project.createdAt))}`
          case "completed":
            return project.completedAt
              ? `Done ${getTimeAgo(new Date(project.completedAt))}`
              : `Updated ${getTimeAgo(new Date(project.updatedAt))}`
          case "canceled":
            return project.canceledAt
              ? `Canceled ${getTimeAgo(new Date(project.canceledAt))}`
              : `Updated ${getTimeAgo(new Date(project.updatedAt))}`
          case "planned":
            return project.startDate
              ? `Start: ${project.startDate}`
              : project.targetDate
              ? `Target: ${project.targetDate}`
              : `Created ${getTimeAgo(new Date(project.createdAt))}`
          case "backlog":
          case "paused":
          default:
            return `Updated ${getTimeAgo(new Date(project.updatedAt))}`
        }
      }

      // Define column widths based on actual data
      const { columns } = Deno.stdout.isTerminal()
        ? Deno.consoleSize()
        : { columns: 120 }
      const SLUG_WIDTH = Math.max(
        4, // minimum width for "SLUG" header
        ...projects.map((project) => project.slugId.length),
      )
      const STATUS_WIDTH = Math.max(
        6, // minimum width for "STATUS" header
        ...projects.map((project) => project.status.name.length),
      )

      // Calculate priority and health widths based on actual values
      const priorityMap = {
        0: "None",
        1: "Urgent",
        2: "High",
        3: "Medium",
        4: "Low",
      }
      const PRIORITY_WIDTH = Math.max(
        8, // minimum width for "PRIORITY" header
        ...projects.map((project) => {
          const priority =
            priorityMap[project.priority as keyof typeof priorityMap] || "None"
          return priority.length
        }),
      )
      const HEALTH_WIDTH = Math.max(
        6, // minimum width for "HEALTH" header
        ...projects.map((project) => {
          const health = project.health || "Unknown"
          return health.length
        }),
      )

      const LEAD_WIDTH = Math.max(
        4, // minimum width for "LEAD" header
        ...projects.map((project) => (project.lead?.initials || "-").length),
      )
      const TEAMS_WIDTH = Math.max(
        5, // minimum width for "TEAMS" header
        ...projects.map((project) => {
          const teams = project.teams.nodes.map((t) => t.key).join(",") || "-"
          return teams.length
        }),
      )
      const DATE_WIDTH = Math.max(
        4, // minimum width for "DATE" header
        ...projects.map((project) => getDisplayDate(project).length),
      )
      const SPACE_WIDTH = 4

      const fixed = SLUG_WIDTH + STATUS_WIDTH + PRIORITY_WIDTH + HEALTH_WIDTH +
        LEAD_WIDTH + TEAMS_WIDTH + DATE_WIDTH + SPACE_WIDTH
      const PADDING = 1
      const maxNameWidth = Math.max(
        ...projects.map((project) => unicodeWidth(project.name)),
      )
      const availableWidth = Math.max(columns - PADDING - fixed, 0)
      const nameWidth = Math.min(maxNameWidth, availableWidth)

      // Print header
      const headerCells = [
        padDisplay("SLUG", SLUG_WIDTH),
        padDisplay("NAME", nameWidth),
        padDisplay("STATUS", STATUS_WIDTH),
        padDisplay("PRIORITY", PRIORITY_WIDTH),
        padDisplay("HEALTH", HEALTH_WIDTH),
        padDisplay("LEAD", LEAD_WIDTH),
        padDisplay("TEAMS", TEAMS_WIDTH),
        padDisplay("DATE", DATE_WIDTH),
      ]

      console.log(underline(headerCells.join(" ")))

      // Print each project
      for (const project of projects) {
        const priorityMap = {
          0: "None",
          1: "Urgent",
          2: "High",
          3: "Medium",
          4: "Low",
        }
        const priority =
          priorityMap[project.priority as keyof typeof priorityMap] || "None"
        const health = project.health || "Unknown"
        const lead = project.lead?.initials || "-"
        const teams = project.teams.nodes.map((t) => t.key).join(",") || "-"
        const dateDisplay = getDisplayDate(project)

        const truncName = project.name.length > nameWidth
          ? project.name.slice(0, nameWidth - 3) + "..."
          : padDisplay(project.name, nameWidth)

        console.log(
          `${padDisplay(project.slugId, SLUG_WIDTH)} ${truncName} ${
            rgb24(
              `${padDisplay(project.status.name, STATUS_WIDTH)} ${
                padDisplay(priority, PRIORITY_WIDTH)
              } ${padDisplay(health, HEALTH_WIDTH)} ${
                padDisplay(lead, LEAD_WIDTH)
              } ${padDisplay(teams, TEAMS_WIDTH)} `,
              parseInt(project.status.color.replace("#", ""), 16),
            )
          }${rgb24(padDisplay(dateDisplay, DATE_WIDTH), 0x808080)}`,
        )
      }
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to fetch projects")
    }
  })
