type PullRequestEvent = {
  pull_request?: {
    body?: string | null
  }
}

type GraphQLIssue = {
  identifier: string
  archivedAt: string | null
  url: string
  state: {
    name: string
    type: string
  }
  team: {
    key: string
  }
}

type GraphQLResponse = {
  data?: {
    issue?: GraphQLIssue | null
  }
  errors?: Array<{ message?: string }>
}

export type LinearPrGateReport = {
  identifiers: string[]
  issues: GraphQLIssue[]
  violations: string[]
  error?: string
}

const ISSUE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/
const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]*$/
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql"
const ISSUE_QUERY = `
  query VerifyIssue($id: String!) {
    issue(id: $id) {
      identifier
      archivedAt
      url
      state {
        name
        type
      }
      team {
        key
      }
    }
  }
`

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function asGraphQLResponse(value: unknown): GraphQLResponse {
  if (value === null || typeof value !== "object") {
    throw new Error("Linear API returned a non-object response")
  }
  return value as GraphQLResponse
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function extractLinearIssueIdentifiers(
  body: string,
  fieldName = "Linear-Issues",
): string[] {
  const fieldPattern = new RegExp(
    `^\\s*${escapeRegularExpression(fieldName)}\\s*:\\s*(.*?)\\s*$`,
    "i",
  )
  const values = body
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = fieldPattern.exec(line)
      return match === null ? [] : [match[1]]
    })

  if (values.length === 0) {
    throw new Error(
      `PR body must contain one ${fieldName}: <ISSUE-ID ...> line`,
    )
  }
  if (values.length > 1) {
    throw new Error(`PR body must contain only one ${fieldName}: line`)
  }

  const identifiers = values[0].split(/[,\s]+/).filter(Boolean)
  if (identifiers.length === 0) {
    throw new Error(
      `${fieldName}: must contain at least one Linear Issue identifier`,
    )
  }

  const invalid = identifiers.filter((identifier) =>
    !ISSUE_IDENTIFIER_PATTERN.test(identifier)
  )
  if (invalid.length > 0) {
    throw new Error(`invalid Linear Issue identifier(s): ${invalid.join(", ")}`)
  }

  const normalized = identifiers.map((identifier) => identifier.toUpperCase())
  const duplicates = normalized.filter((identifier, index) =>
    normalized.indexOf(identifier) !== index
  )
  if (duplicates.length > 0) {
    throw new Error(
      `duplicate Linear Issue identifier(s): ${
        [...new Set(duplicates)].join(", ")
      }`,
    )
  }
  return normalized
}

export function parseAllowedTeamKeys(value: string): Set<string> {
  const keys = value
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((key) => key.toUpperCase())
  if (keys.length === 0 || keys.some((key) => !TEAM_KEY_PATTERN.test(key))) {
    throw new Error(
      "LINEAR_GATE_ALLOWED_TEAM_KEYS must contain valid Linear team keys",
    )
  }
  return new Set(keys)
}

export async function fetchLinearIssue(
  identifier: string,
  apiKey: string,
  endpoint = LINEAR_GRAPHQL_ENDPOINT,
): Promise<GraphQLIssue> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      "User-Agent": "jihuanshe-linear-pr-gate",
    },
    body: JSON.stringify({
      query: ISSUE_QUERY,
      variables: { id: identifier },
    }),
  })
  const responseBody = asGraphQLResponse(await response.json())
  if (!response.ok) {
    throw new Error(`Linear API request failed with HTTP ${response.status}`)
  }
  if (responseBody.errors?.length) {
    const message = responseBody.errors.map((error) =>
      error.message || "unknown GraphQL error"
    ).join("; ")
    throw new Error(`Linear API rejected ${identifier}: ${message}`)
  }
  const issue = responseBody.data?.issue
  if (issue == null) {
    throw new Error(
      `Linear Issue does not exist or is not accessible: ${identifier}`,
    )
  }
  return issue
}

export function evaluateLinearIssues(
  issues: GraphQLIssue[],
  allowedTeamKeys: Set<string>,
): string[] {
  const violations: string[] = []
  for (const issue of issues) {
    if (!allowedTeamKeys.has(issue.team.key.toUpperCase())) {
      violations.push(
        `${issue.identifier} belongs to team ${issue.team.key}, not an allowed team`,
      )
    }
    if (issue.archivedAt !== null) {
      violations.push(`${issue.identifier} is archived`)
    }
    if (issue.state.type.toLowerCase() === "canceled") {
      violations.push(`${issue.identifier} is canceled`)
    }
  }
  return violations
}

export function formatSummary(
  report: LinearPrGateReport,
  enforce: boolean,
  allowedTeamKeys: Set<string>,
): string {
  const mode = enforce ? "enforced" : "shadow"
  const lines = [
    `## Linear PR Gate (${mode})`,
    "",
    `Allowed teams: ${[...allowedTeamKeys].join(", ")}`,
  ]

  if (report.identifiers.length > 0) {
    lines.push(`Declared Issues: ${report.identifiers.join(", ")}`)
  }
  if (report.issues.length > 0) {
    lines.push(
      ...report.issues.map(
        (issue) =>
          `- ${issue.identifier} · ${issue.team.key} · ${issue.state.name} · ${issue.url}`,
      ),
    )
  }
  if (report.error !== undefined) {
    lines.push(
      "",
      `Result: ${enforce ? "failed" : "warning"}`,
      `Reason: ${report.error}`,
    )
  } else if (report.violations.length > 0) {
    lines.push(
      "",
      `Result: ${enforce ? "failed" : "warning"}`,
      ...report.violations.map((violation) => `- ${violation}`),
    )
  } else {
    lines.push("", "Result: passed")
  }
  if (!enforce) {
    lines.push(
      "",
      "Shadow mode does not block merging. Set `enforce: true` after the pilot is validated.",
    )
  }
  return `${lines.join("\n")}\n`
}

async function readPullRequestBody(): Promise<string> {
  const eventPath = Deno.env.get("GITHUB_EVENT_PATH")
  if (eventPath === undefined || eventPath === "") {
    throw new Error("GITHUB_EVENT_PATH is required")
  }
  const event = JSON.parse(
    await Deno.readTextFile(eventPath),
  ) as PullRequestEvent
  return event.pull_request?.body || ""
}

async function writeSummary(summary: string): Promise<void> {
  const summaryPath = Deno.env.get("GITHUB_STEP_SUMMARY")
  if (summaryPath === undefined || summaryPath === "") return
  await Deno.writeTextFile(summaryPath, summary, { append: true })
}

export async function runLinearPrGate(): Promise<number> {
  const enforce = ["1", "true", "yes"].includes(
    (Deno.env.get("LINEAR_GATE_ENFORCE") || "false").toLowerCase(),
  )
  const allowedTeamKeys = parseAllowedTeamKeys(
    Deno.env.get("LINEAR_GATE_ALLOWED_TEAM_KEYS") || "",
  )
  const report: LinearPrGateReport = {
    identifiers: [],
    issues: [],
    violations: [],
  }

  try {
    report.identifiers = extractLinearIssueIdentifiers(
      await readPullRequestBody(),
    )
    const apiKey = Deno.env.get("LINEAR_API_KEY")
    if (apiKey === undefined || apiKey === "") {
      report.error =
        "LINEAR_API_KEY is not configured; Linear API verification was skipped"
    } else {
      report.issues = await Promise.all(
        report.identifiers.map((identifier) =>
          fetchLinearIssue(identifier, apiKey)
        ),
      )
      report.violations = evaluateLinearIssues(report.issues, allowedTeamKeys)
    }
  } catch (error) {
    report.error = errorMessage(error)
  }

  const summary = formatSummary(report, enforce, allowedTeamKeys)
  console.log(summary.trimEnd())
  await writeSummary(summary)
  return enforce && (report.error !== undefined || report.violations.length > 0)
    ? 1
    : 0
}

if (import.meta.main) {
  Deno.exitCode = await runLinearPrGate()
}
