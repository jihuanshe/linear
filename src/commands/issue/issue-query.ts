import { Command, EnumType } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { unicodeWidth } from "@std/cli"
import { rgb24 } from "@std/fmt/colors"
import { resolveIssueSort } from "../../config.ts"
import {
  colorCycleShort,
  type CycleDisplayInfo,
  formatCycleShort,
  getPriorityDisplay,
  getTimeAgo,
  padDisplay,
  truncateText,
} from "../../utils/display.ts"
import {
  fetchIssuesForQuery,
  getCycleIdByNameOrNumber,
  getProjectIdByName,
  getProjectOptionsByName,
  getTeamIdByKey,
  getTeamKey,
  isIssueBlocked,
  isLinearUuid,
  lookupUserId,
  resolveMilestoneId,
  searchIssuesByTerm,
  selectOption,
} from "../../utils/linear.ts"
import { pipeToUserPager, shouldUsePager } from "../../utils/pager.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { header, muted, warning } from "../../utils/styling.ts"
import {
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

const SortType = new EnumType(["manual", "priority"])
const StateType = new EnumType([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
])
const URL_LOOKUP_CONCURRENCY = 4

function validateExactUrl(value: string, source: string): string {
  const exactUrl = value.trim()
  if (exactUrl.length === 0) {
    throw new ValidationError(`${source} cannot be empty`)
  }
  try {
    new URL(exactUrl)
  } catch {
    throw new ValidationError(`Invalid URL: "${value}"`, {
      suggestion:
        "Pass an absolute URL including its scheme, for example https://example.com/feedback/123.",
    })
  }
  return exactUrl
}

async function readExactUrlFile(filePath: string): Promise<string[]> {
  let content: string
  try {
    content = await Deno.readTextFile(filePath)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new NotFoundError("URL file", filePath)
    }
    throw error
  }

  const urls = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => validateExactUrl(line, `--url-file entry in ${filePath}`))

  if (urls.length === 0) {
    throw new ValidationError(`--url-file contains no URLs: ${filePath}`)
  }
  return [...new Set(urls)]
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const worker = async () => {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

export const queryCommand = withUsageMetadata(new Command(), {
  interactive: true,
})
  .name("query")
  .description("Query issues with structured filters")
  .type("sort", SortType)
  .type("state", StateType)
  .option(
    "--search <term:string>",
    "Full-text search term",
  )
  .option(
    "--url <url:string>",
    "Find an issue by Linear URL, or by an exact URL occurrence in its description or comments (URL mode returns all exact matches; --limit is ignored)",
  )
  .option(
    "--url-file <path:string>",
    "Find issues for one URL per line (blank lines and lines starting with # are ignored); JSON returns lookups in input order",
  )
  .option(
    "--search-comments",
    "Also search inside issue comments (requires --search)",
  )
  .option(
    "--team <team:string>",
    "Filter by team key (can be repeated for multiple teams)",
    { collect: true },
  )
  .option("--all-teams", "Query across all teams")
  .option(
    "-s, --state <state:state>",
    "Filter by issue state (can be repeated for multiple states)",
    { collect: true },
  )
  .option(
    "--state-name <name:string>",
    "Filter by exact workflow state name (case-insensitive; can be repeated)",
    { collect: true },
  )
  .option(
    "--assignee <assignee:string>",
    "Filter by assignee (username, name, email, 'self', or '@me')",
  )
  .option("-U, --unassigned", "Show only unassigned issues")
  .option(
    "--sort <sort:sort>",
    "Sort order: manual or priority (default: priority, not available with --search)",
    { required: false },
  )
  .option(
    "--project <project:string>",
    "Filter by project (UUID, slug ID, or name)",
  )
  .option(
    "--unprojected",
    "Show only issues that are not assigned to a project",
  )
  .option(
    "--project-label <projectLabel:string>",
    "Filter by project label name (shows issues from all projects with this label)",
  )
  .option(
    "--cycle <cycle:string>",
    "Filter by cycle name, number, 'active'/'now', 'next', 'previous', or a relative offset like +1",
  )
  .option(
    "--milestone <milestone:string>",
    "Filter by project milestone (UUID, or name when --project is set)",
  )
  .option(
    "-l, --label <label:string>",
    "Filter by label name (can be repeated for multiple labels)",
    { collect: true },
  )
  .option(
    "--limit <limit:number>",
    "Maximum number of issues to fetch (default: 50, use 0 for unlimited)",
    { default: 50 },
  )
  .option(
    "--created-after <date:string>",
    "Filter issues created after this date (ISO 8601 or YYYY-MM-DD)",
  )
  .option(
    "--updated-after <date:string>",
    "Filter issues updated after this date (ISO 8601 or YYYY-MM-DD)",
  )
  .option("--include-archived", "Include archived issues")
  .option("-j, --json", "Output results as JSON")
  .option("--no-pager", "Disable automatic paging for long output")
  .action(async (options) => {
    const {
      search,
      url,
      urlFile,
      searchComments,
      team: teamFlags,
      allTeams,
      state,
      stateName,
      assignee,
      unassigned,
      sort: sortFlag,
      project,
      unprojected,
      projectLabel,
      cycle,
      milestone,
      label,
      limit,
      createdAfter,
      updatedAfter,
      includeArchived,
      json,
      pager,
    } = options

    let spinner:
      | InstanceType<typeof import("@std/cli/unstable-spinner").Spinner>
      | null = null

    try {
      // --- Validation ---

      const teamKeys = teamFlags
        ? (Array.isArray(teamFlags) ? teamFlags.flat() : [teamFlags]).map((
          t: string,
        ) => t.toUpperCase())
        : undefined

      if (teamKeys && teamKeys.length > 0 && allTeams) {
        throw new ValidationError(
          "Cannot use both --team and --all-teams flags",
        )
      }

      const assigneeFilterCount = [assignee, unassigned].filter(Boolean).length
      if (assigneeFilterCount > 1) {
        throw new ValidationError(
          "Cannot specify both --assignee and --unassigned",
        )
      }

      const stateArray = state
        ? (Array.isArray(state) ? state.flat() : [state])
        : undefined

      const stateNames = stateName
        ? (Array.isArray(stateName) ? stateName.flat() : [stateName]).map((
          name: string,
        ) => name.trim())
        : undefined

      if (stateNames?.some((name: string) => name.length === 0)) {
        throw new ValidationError("--state-name cannot be empty")
      }

      if (
        stateArray && stateArray.length > 0 &&
        stateNames && stateNames.length > 0
      ) {
        throw new ValidationError(
          "Cannot use both --state and --state-name flags",
          {
            suggestion:
              "Use --state for a broad Linear state type, or --state-name for an exact workflow state name.",
          },
        )
      }

      const projectFilterCount = [
        project != null,
        projectLabel != null,
        unprojected === true,
      ].filter(Boolean).length
      if (projectFilterCount > 1) {
        throw new ValidationError(
          "Cannot combine --project, --project-label, and --unprojected",
          {
            suggestion:
              "Use exactly one project filter: --project, --project-label, or --unprojected.",
          },
        )
      }

      if (unprojected === true && milestone != null) {
        throw new ValidationError(
          "--milestone cannot be used with --unprojected",
          {
            suggestion:
              "Use --project to specify a project when filtering by milestone.",
          },
        )
      }

      if (milestone != null && project == null && !isLinearUuid(milestone)) {
        throw new ValidationError(
          "--milestone requires --project to be set",
          {
            suggestion:
              "Use --project to specify which project the milestone belongs to, or pass a milestone UUID directly.",
          },
        )
      }

      if (milestone != null && projectLabel != null) {
        throw new ValidationError(
          "--milestone cannot be used with --project-label",
          {
            suggestion:
              "Use --project to specify a single project when filtering by milestone.",
          },
        )
      }

      if (searchComments && !search) {
        throw new ValidationError(
          "--search-comments requires --search to be set",
          {
            suggestion:
              'Use --search to provide a search term, e.g. --search "oauth timeout" --search-comments.',
          },
        )
      }

      if (search != null && url != null) {
        throw new ValidationError(
          "Cannot use both --search and --url",
          {
            suggestion:
              "Use --url for exact URL deduplication, or --search for relevance-ranked full-text search.",
          },
        )
      }

      if (search != null && urlFile != null) {
        throw new ValidationError(
          "Cannot use both --search and --url-file",
          {
            suggestion:
              "Use --url-file for exact URL deduplication, or --search for relevance-ranked full-text search.",
          },
        )
      }

      if (url != null && urlFile != null) {
        throw new ValidationError(
          "Cannot use both --url and --url-file",
          {
            suggestion:
              "Pass one URL with --url, or put one URL per line in --url-file.",
          },
        )
      }

      const exactUrl = url == null ? undefined : validateExactUrl(url, "--url")
      const exactUrls = urlFile == null
        ? undefined
        : await readExactUrlFile(urlFile)

      let resolvedBatchAssigneeId: string | undefined
      if (exactUrls != null && assignee != null) {
        resolvedBatchAssigneeId = await lookupUserId(assignee)
        if (!resolvedBatchAssigneeId) {
          throw new NotFoundError("User", assignee)
        }
      }

      if (sortFlag && search) {
        throw new ValidationError(
          "--sort cannot be used with --search",
          {
            suggestion:
              "Search results use relevance ordering. Remove --sort when using --search.",
          },
        )
      }

      if (limit < 0) {
        throw new ValidationError("--limit must be 0 or greater")
      }

      // --- Team scope resolution ---

      let resolvedTeamKeys: string[] | undefined
      let isMultiTeam = false

      if (allTeams) {
        resolvedTeamKeys = undefined
        isMultiTeam = true
      } else if (teamKeys && teamKeys.length > 0) {
        resolvedTeamKeys = teamKeys
        isMultiTeam = teamKeys.length > 1
      } else if (project != null) {
        // A project filter already scopes the query; do not narrow it to the
        // configured default team unless the caller explicitly asks for one.
        resolvedTeamKeys = undefined
        isMultiTeam = true
      } else {
        const defaultTeam = getTeamKey()
        if (!defaultTeam) {
          throw new ValidationError(
            "No default team configured and no team scope provided",
            {
              suggestion:
                "Use --team <key> to specify a team, or --all-teams to query the whole workspace.",
            },
          )
        }
        console.error(
          `Note: using default team ${defaultTeam}. Pass --team <key> or --all-teams to be explicit.`,
        )
        resolvedTeamKeys = [defaultTeam]
      }

      // --- Resolve entity IDs ---

      let projectId: string | undefined
      if (project != null) {
        projectId = await getProjectIdByName(project)
        if (projectId == null) {
          const projectOptions = await getProjectOptionsByName(project)
          if (Object.keys(projectOptions).length === 0) {
            throw new NotFoundError("Project", project)
          }
          if (!Deno.stdin.isTerminal()) {
            throw new ValidationError(
              `Project "${project}" not found. Similar projects: ${
                Object.values(projectOptions).join(", ")
              }`,
            )
          }
          projectId = await selectOption("Project", project, projectOptions)
        }
      }

      let cycleId: string | undefined
      if (cycle != null) {
        // Cycle lookup requires a single team
        if (isMultiTeam || !resolvedTeamKeys || resolvedTeamKeys.length !== 1) {
          throw new ValidationError(
            "--cycle requires a single team scope",
            {
              suggestion:
                "Use --team <key> to specify exactly one team when filtering by cycle.",
            },
          )
        }
        const teamId = await getTeamIdByKey(resolvedTeamKeys[0])
        if (!teamId) {
          throw new NotFoundError("Team", resolvedTeamKeys[0])
        }
        cycleId = await getCycleIdByNameOrNumber(cycle, teamId)
      }

      let milestoneId: string | undefined
      if (milestone != null) {
        milestoneId = isLinearUuid(milestone)
          ? milestone
          : await resolveMilestoneId(milestone, projectId)
      }

      const labelNames = label && label.length > 0
        ? (Array.isArray(label) ? label.flat() : [label])
        : undefined

      // --- Fetch ---

      const { Spinner } = await import("@std/cli/unstable-spinner")
      const showSpinner = shouldShowSpinner() && !json
      spinner = showSpinner ? new Spinner() : null
      spinner?.start()

      // Resolve sort for non-search mode
      const sort = search ? undefined : resolveIssueSort(sortFlag)

      if (exactUrls != null) {
        // Keep URL order in the result so a caller can reconcile each lookup
        // without matching on an issue title or identifier.
        const results = await mapWithConcurrency(
          exactUrls,
          URL_LOOKUP_CONCURRENCY,
          (target) =>
            fetchIssuesForQuery({
              teamKeys: resolvedTeamKeys,
              allTeams: allTeams === true,
              state: stateArray,
              stateNames,
              assignee,
              assigneeId: resolvedBatchAssigneeId,
              unassigned,
              sort,
              limit: limit === 0 ? 0 : limit,
              projectId,
              noProject: unprojected === true,
              projectLabel,
              cycleId,
              milestoneId,
              labelNames,
              createdAfter,
              updatedAfter,
              includeArchived,
              exactUrl: target,
            }),
        )

        spinner?.stop()

        if (json) {
          console.log(
            JSON.stringify(
              {
                lookups: exactUrls.map((target, index) => ({
                  url: target,
                  ...results[index],
                })),
              },
              null,
              2,
            ),
          )
          return
        }

        const showAssignee = assignee == null && !unassigned
        const outputLines: string[] = []
        for (const [index, result] of results.entries()) {
          outputLines.push("", exactUrls[index])
          if (result.nodes.length === 0) {
            outputLines.push("No issues found.")
            continue
          }
          outputLines.push(
            ...formatIssueTable(result.nodes, isMultiTeam, showAssignee),
          )
        }
        await outputPaged(outputLines, pager !== false)
      } else if (search) {
        // --- Search mode: use searchIssues() backend ---
        const searchTerm = search.trim()
        if (searchTerm.length === 0) {
          throw new ValidationError("--search term cannot be empty")
        }

        const result = await searchIssuesByTerm(searchTerm, {
          teamKeys: resolvedTeamKeys,
          state: stateArray,
          stateNames,
          assignee,
          unassigned,
          limit: limit === 0 ? 0 : limit,
          projectId,
          noProject: unprojected === true,
          projectLabel,
          cycleId,
          labelNames,
          createdAfter,
          updatedAfter,
          includeComments: searchComments,
          includeArchived,
        })

        spinner?.stop()

        if (json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }

        if (result.nodes.length === 0) {
          console.log("No issues found.")
          return
        }

        const showAssignee = assignee == null && !unassigned
        const outputLines = formatIssueTable(
          result.nodes,
          isMultiTeam,
          showAssignee,
        )
        outputPaged(outputLines, pager !== false)
      } else {
        // --- Filter mode: use issues() backend ---
        const result = await fetchIssuesForQuery({
          teamKeys: resolvedTeamKeys,
          allTeams: allTeams === true,
          state: stateArray,
          stateNames,
          assignee,
          unassigned,
          sort,
          limit: limit === 0 ? 0 : limit,
          projectId,
          noProject: unprojected === true,
          projectLabel,
          cycleId,
          milestoneId,
          labelNames,
          createdAfter,
          updatedAfter,
          includeArchived,
          exactUrl,
        })

        spinner?.stop()

        if (json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }

        if (result.nodes.length === 0) {
          console.log("No issues found.")
          return
        }

        const showAssignee = assignee == null && !unassigned
        const outputLines = formatIssueTable(
          result.nodes,
          isMultiTeam,
          showAssignee,
        )
        outputPaged(outputLines, pager !== false)
      }
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to query issues")
    }
  })

async function outputPaged(
  outputLines: string[],
  usePager: boolean,
): Promise<void> {
  if (shouldUsePager(outputLines, usePager)) {
    await pipeToUserPager(outputLines.join("\n"))
  } else {
    outputLines.forEach((line) => console.log(line))
  }
}

// Display types shared by both backends
interface DisplayableIssue {
  identifier: string
  title: string
  priority: number
  estimate?: number | null
  updatedAt: string
  state: { name: string; color: string }
  assignee?: { initials: string } | null
  team?: {
    key: string
    cyclesEnabled?: boolean
    activeCycle?: { number: number } | null
  }
  cycle?: CycleDisplayInfo | null
  labels: { nodes: Array<{ name: string; color: string }> }
  inverseRelations?: {
    nodes: Array<{
      type: string
      issue?: { state?: { type?: string | null } | null } | null
    }>
  } | null
}

function formatIssueTable(
  issues: DisplayableIssue[],
  showTeamColumn: boolean,
  showAssigneeColumn: boolean,
): string[] {
  const { columns } = Deno.stdout.isTerminal()
    ? Deno.consoleSize()
    : { columns: 120 }

  const priorityWidth = 3
  const blockedWidth = 1
  const idWidth = Math.max(2, ...issues.map((i) => i.identifier.length))
  const teamWidth = showTeamColumn
    ? Math.max(
      4,
      ...issues.map((i) => unicodeWidth(i.team?.key ?? "")),
    )
    : 0
  const labelWidth = Math.min(
    25,
    Math.max(
      6,
      ...issues.map((i) =>
        unicodeWidth(i.labels.nodes.map((l) => l.name).join(", "))
      ),
    ),
  )
  const estimateWidth = 1
  const showCycleColumn = issues.some((i) =>
    i.cycle != null || i.team?.cyclesEnabled === true
  )
  const cycleShorts = issues.map((i) =>
    formatCycleShort(i.cycle, i.team?.activeCycle?.number)
  )
  const cycleWidth = showCycleColumn
    ? Math.max(3, ...cycleShorts.map((c) => unicodeWidth(c.text)))
    : 0
  const assigneeWidth = showAssigneeColumn ? 2 : 0
  const stateWidth = Math.min(
    20,
    Math.max(5, ...issues.map((i) => unicodeWidth(i.state.name))),
  )
  const updatedHeader = "UPDATED"
  const updatedWidth = Math.max(
    unicodeWidth(updatedHeader),
    ...issues.map((i) => unicodeWidth(getTimeAgo(new Date(i.updatedAt)))),
  )

  const fixedCells = [
    priorityWidth,
    idWidth,
    ...(showTeamColumn ? [teamWidth] : []),
    labelWidth,
    blockedWidth,
    estimateWidth,
    ...(showCycleColumn ? [cycleWidth] : []),
    ...(showAssigneeColumn ? [assigneeWidth] : []),
    stateWidth,
    updatedWidth,
  ]
  const interCellSpacing = fixedCells.length + 1
  const fixedWidth = fixedCells.reduce((sum, w) => sum + w, 0) +
    interCellSpacing
  const maxTitleWidth = Math.max(...issues.map((i) => unicodeWidth(i.title)))
  const titleWidth = Math.max(10, Math.min(maxTitleWidth, columns - fixedWidth))

  const headerCells = [
    padDisplay("◌", priorityWidth),
    padDisplay("ID", idWidth),
    ...(showTeamColumn ? [padDisplay("TEAM", teamWidth)] : []),
    padDisplay("TITLE", titleWidth),
    padDisplay("LABELS", labelWidth),
    padDisplay("B", blockedWidth),
    padDisplay("E", estimateWidth),
    ...(showCycleColumn ? [padDisplay("CYC", cycleWidth)] : []),
    ...(showAssigneeColumn ? [padDisplay("A", assigneeWidth)] : []),
    padDisplay("STATE", stateWidth),
    padDisplay(updatedHeader, updatedWidth),
  ]

  const outputLines = [header(headerCells.join(" "))]

  for (const [index, issue] of issues.entries()) {
    const title = padDisplay(
      truncateText(issue.title, titleWidth),
      titleWidth,
    )
    const stateName = truncateText(issue.state.name, stateWidth)
    const coloredState = rgb24(
      stateName,
      parseInt(issue.state.color.replace("#", ""), 16),
    )
    const state = coloredState +
      " ".repeat(Math.max(0, stateWidth - unicodeWidth(stateName)))
    const timeAgo = muted(
      padDisplay(getTimeAgo(new Date(issue.updatedAt)), updatedWidth),
    )
    const blockedCell = isIssueBlocked(issue) ? warning("⊘") : " "
    const cycleShort = cycleShorts[index]
    const cycleCell = colorCycleShort(cycleShort) +
      " ".repeat(Math.max(0, cycleWidth - unicodeWidth(cycleShort.text)))
    const cells = [
      padDisplay(getPriorityDisplay(issue.priority), priorityWidth),
      padDisplay(issue.identifier, idWidth),
      ...(showTeamColumn ? [padDisplay(issue.team?.key ?? "", teamWidth)] : []),
      title,
      formatLabels(issue.labels.nodes, labelWidth),
      padDisplay(blockedCell, blockedWidth),
      padDisplay(issue.estimate?.toString() || "-", estimateWidth),
      ...(showCycleColumn ? [cycleCell] : []),
      ...(showAssigneeColumn
        ? [
          padDisplay(
            issue.assignee?.initials?.slice(0, 2) || "-",
            assigneeWidth,
          ),
        ]
        : []),
      state,
      timeAgo,
    ]
    outputLines.push(cells.join(" "))
  }

  return outputLines
}

function formatLabels(
  labels: Array<{ name: string; color: string }>,
  labelWidth: number,
): string {
  if (labels.length === 0) {
    return " ".repeat(labelWidth)
  }

  const coloredLabels: string[] = []
  let currentWidth = 0

  for (let i = 0; i < labels.length; i++) {
    const currentLabel = labels[i]
    const coloredLabel = rgb24(
      currentLabel.name,
      parseInt(currentLabel.color.replace("#", ""), 16),
    )
    const separator = i > 0 ? ", " : ""
    const testText = separator + currentLabel.name

    if (currentWidth + unicodeWidth(testText) > labelWidth) {
      const remainingWidth = labelWidth - currentWidth
      if (remainingWidth >= 4) {
        const truncatedName = truncateText(
          currentLabel.name,
          remainingWidth - separator.length,
        )
        coloredLabels.push(
          separator +
            rgb24(
              truncatedName,
              parseInt(currentLabel.color.replace("#", ""), 16),
            ),
        )
      }
      break
    }

    coloredLabels.push(separator + coloredLabel)
    currentWidth += unicodeWidth(testText)
  }

  const result = coloredLabels.join("")
  const ansiRegex = new RegExp("\u001B\\[[0-9;]*m", "g")
  const visibleWidth = unicodeWidth(result.replace(ansiRegex, ""))
  return result + " ".repeat(Math.max(0, labelWidth - visibleWidth))
}
