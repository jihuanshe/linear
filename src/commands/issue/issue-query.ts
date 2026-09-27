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
  fetchIssuesByIdentifiers,
  fetchIssuesForQuery,
  getCycleIdByNameOrNumber,
  getProjectOptionsByName,
  getTeamKey,
  isIssueBlocked,
  isLinearUuid,
  type IssueUrlResolution,
  lookupProjectId,
  lookupUserId,
  mapWithConcurrency,
  resolveMilestoneId,
  searchIssuesByTerm,
  selectOption,
} from "../../utils/linear.ts"
import { resolveTeam } from "../../utils/issue-read.ts"
import { normalizeIssueIdentifier } from "../../utils/issue-identifier.ts"
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
        "Pass an absolute URL including its scheme, for example https://example.com/objects/123.",
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

// Linear rejects the whole `issues(filter: {id: {in}})` request with an
// "Argument Validation Error" that names no element when any identifier has a
// team key longer than 7 characters or a number above 999,999,999 (measured
// 2026-09-27), so such values are rejected here, all listed, before any request.
const MAX_TEAM_KEY_LENGTH = 7
const MAX_ISSUE_NUMBER = 999_999_999

function isAcceptedIssueIdentifier(identifier: string | undefined): boolean {
  if (identifier == null) return false
  const [teamKey, number] = identifier.split("-")
  return teamKey.length <= MAX_TEAM_KEY_LENGTH &&
    Number(number) <= MAX_ISSUE_NUMBER
}

/** Normalize every value; report all invalid ones in one error. */
function validateIssueIdentifiers(
  values: readonly string[],
  source: string,
): string[] {
  const invalid: string[] = []
  const identifiers: string[] = []
  for (const value of values) {
    const identifier = normalizeIssueIdentifier(value.trim())
    if (isAcceptedIssueIdentifier(identifier)) identifiers.push(identifier!)
    else invalid.push(value)
  }
  if (invalid.length > 0) {
    throw new ValidationError(
      `Invalid issue identifier${
        invalid.length === 1 ? "" : "s"
      } in ${source}: ${
        invalid.map((value) => JSON.stringify(value)).join(", ")
      }`,
      {
        suggestion:
          `Pass identifiers such as ENG-123, one per --id or per line: a team key of at most ${MAX_TEAM_KEY_LENGTH} characters and a number from 1 to ${
            MAX_ISSUE_NUMBER.toLocaleString("en-US")
          }.`,
        details: { invalid },
      },
    )
  }
  return identifiers
}

async function readIssueIdentifierFile(filePath: string): Promise<string[]> {
  let content: string
  try {
    content = await Deno.readTextFile(filePath)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new NotFoundError("Identifier file", filePath)
    }
    throw error
  }
  const identifiers = validateIssueIdentifiers(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
    `--id-file ${filePath}`,
  )
  if (identifiers.length === 0) {
    throw new ValidationError(`--id-file contains no identifiers: ${filePath}`)
  }
  return identifiers
}

/** Options that filter or order a result set; ID mode reports every request. */
const ID_MODE_CONFLICTS = [
  ["search", "--search"],
  ["searchComments", "--search-comments"],
  ["url", "--url"],
  ["urlFile", "--url-file"],
  ["team", "--team"],
  ["allTeams", "--all-teams"],
  ["stateType", "--state-type"],
  ["stateName", "--state-name"],
  ["assignee", "--assignee"],
  ["unassigned", "--unassigned"],
  ["sort", "--sort"],
  ["project", "--project"],
  ["unprojected", "--unprojected"],
  ["projectLabel", "--project-label"],
  ["cycle", "--cycle"],
  ["milestone", "--milestone"],
  ["label", "--label"],
  ["createdAfter", "--created-after"],
  ["updatedAfter", "--updated-after"],
] as const

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
    "Find an issue by Linear URL, or by an exact URL occurrence in its description or comments (URL mode returns all exact matches; --limit is ignored). A Linear Issue URL also resolves identifiers from before a team move and adds resolution {status: found|moved|trashed|archived|not_found, requested, identifier}; trashed and archived issues need --include-archived to appear in nodes",
    { preserveEmpty: true },
  )
  .option(
    "--url-file <path:string>",
    "Find issues for one URL per line (blank lines and lines starting with # are ignored); JSON returns {lookups: [{url, nodes, pageInfo, resolution?}]} in input order, with resolution as in --url for Linear Issue URLs; --limit is ignored",
    { preserveEmpty: true },
  )
  .option(
    "--id <identifier:string>",
    "Read issues by identifier across all teams (repeatable; duplicates are read once). Identifiers from before a team move resolve to the current issue, and archived and trashed issues are included. JSON returns {nodes, pageInfo, resolutions: [{requested, status: found|moved|trashed|archived|not_found, identifier?}], reconciliation: {requested, read, missing}}: nodes holds each distinct issue once in request order, pageInfo.hasNextPage is always false, and requested = read + missing is checked (a mismatch fails with a non-zero exit). Cannot be combined with filters, --search, or --url; --limit is ignored",
    { collect: true, preserveEmpty: true },
  )
  .option(
    "--id-file <path:string>",
    "Read issues for one identifier per line (blank lines and lines starting with # are ignored); same result and reconciliation as --id",
    { preserveEmpty: true },
  )
  .option(
    "--search-comments",
    "Also search inside issue comments (requires --search)",
  )
  .option(
    "--team <key:string>",
    "Filter by team key (can be repeated for multiple teams)",
    { collect: true },
  )
  .option("--all-teams", "Query across all teams")
  .option(
    "-s, --state-type <type:state>",
    "Filter by workflow state type: triage, backlog, unstarted, started, completed, canceled (repeatable)",
    { collect: true },
  )
  .option(
    "--state-name <name:string>",
    "Filter by exact workflow state name (case-insensitive; can be repeated)",
    { collect: true },
  )
  .option(
    "--assignee <assignee:string>",
    "Filter by assignee (user UUID, username, name, email, 'self', or '@me')",
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
    "--project-label <name:string>",
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
    "-l, --label <name:string>",
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
      id: idFlags,
      idFile,
      searchComments,
      team: teamFlags,
      allTeams,
      stateType,
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
      // --- Identifier mode: cross-team, unfiltered, reconciled ---

      if (idFlags != null || idFile != null) {
        if (idFlags != null && idFile != null) {
          throw new ValidationError("Cannot use both --id and --id-file", {
            suggestion:
              "Repeat --id for a few identifiers, or put one identifier per line in --id-file.",
          })
        }
        const conflict = ID_MODE_CONFLICTS.find(([key]) => {
          const value = options[key]
          return value != null &&
            !(Array.isArray(value) && value.length === 0)
        })
        if (conflict != null) {
          throw new ValidationError(
            `Cannot combine ${idFile != null ? "--id-file" : "--id"} with ${
              conflict[1]
            }`,
            {
              suggestion:
                "Identifier mode reads every requested issue across teams; filter the JSON result instead.",
            },
          )
        }
        const identifiers = idFile != null
          ? await readIssueIdentifierFile(idFile)
          : validateIssueIdentifiers(idFlags!.flat(), "--id")

        const { Spinner } = await import("@std/cli/unstable-spinner")
        spinner = shouldShowSpinner() && !json ? new Spinner() : null
        spinner?.start()
        const result = await fetchIssuesByIdentifiers(identifiers)
        spinner?.stop()

        if (json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }

        const outputLines: string[] = []
        for (const resolution of result.resolutions) {
          const note = describeResolution(resolution, true, false)
          if (note != null) outputLines.push(note)
        }
        if (result.nodes.length > 0) {
          if (outputLines.length > 0) outputLines.push("")
          outputLines.push(...formatIssueTable(result.nodes, true, true))
        }
        const { requested, read, missing } = result.reconciliation
        outputLines.push(
          "",
          `Read ${read} of ${requested} requested ${
            requested === 1 ? "issue" : "issues"
          }; ${missing} not found.`,
        )
        await outputPaged(outputLines, pager !== false)
        return
      }

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

      const stateTypes = stateType?.flat()

      const stateNames = stateName
        ? (Array.isArray(stateName) ? stateName.flat() : [stateName]).map((
          name: string,
        ) => name.trim())
        : undefined

      if (stateNames?.some((name: string) => name.length === 0)) {
        throw new ValidationError("--state-name cannot be empty")
      }

      if (
        stateTypes && stateTypes.length > 0 &&
        stateNames && stateNames.length > 0
      ) {
        throw new ValidationError(
          "Cannot use both --state-type and --state-name flags",
          {
            suggestion:
              "Use --state-type for a workflow state type, or --state-name for an exact workflow state name.",
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
        projectId = await lookupProjectId(project)
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
        const { id: teamId } = await resolveTeam(resolvedTeamKeys[0])
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
      const queryOptions = {
        teamKeys: resolvedTeamKeys,
        allTeams: allTeams === true,
        stateTypes,
        stateNames,
        assignee,
        unassigned,
        sort,
        limit,
        projectId,
        unprojected: unprojected === true,
        projectLabel,
        cycleId,
        milestoneId,
        labelNames,
        createdAfter,
        updatedAfter,
        includeArchived,
      }

      if (exactUrls != null) {
        // Keep URL order in the result so a caller can reconcile each lookup
        // without matching on an issue title or identifier.
        const results = await mapWithConcurrency(
          exactUrls,
          URL_LOOKUP_CONCURRENCY,
          (target) =>
            fetchIssuesForQuery({
              ...queryOptions,
              assigneeId: resolvedBatchAssigneeId,
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
          const note = describeResolution(
            result.resolution,
            includeArchived,
            result.nodes.length === 0,
          )
          if (note != null) outputLines.push(note)
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
          ...queryOptions,
          includeComments: searchComments,
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
          ...queryOptions,
          exactUrl,
        })

        spinner?.stop()

        if (json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }

        const note = describeResolution(
          result.resolution,
          includeArchived,
          result.nodes.length === 0,
        )
        if (note != null) console.log(note)
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

/** One human line for a Linear Issue URL that did not resolve plainly. */
function describeResolution(
  resolution: IssueUrlResolution | undefined,
  includeArchived: boolean | undefined,
  filteredOut: boolean,
): string | undefined {
  if (resolution == null) return undefined
  const { status, requested, identifier } = resolution
  switch (status) {
    case "found":
      return filteredOut
        ? `${requested} resolved, but the selected filters excluded it; try --all-teams or adjust the filters`
        : undefined
    case "moved":
      return `${requested} moved to ${identifier}` +
        (filteredOut
          ? "; the selected filters excluded it; try --all-teams or adjust the filters"
          : "")
    case "not_found":
      return `${requested} does not exist in this workspace`
    case "trashed":
    case "archived":
      return `${
        requested === identifier ? "" : `${requested} moved to ${identifier}; `
      }` +
        `${identifier} is ${status}` +
        (includeArchived ? "" : "; add --include-archived to list it")
  }
}

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
