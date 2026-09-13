import { Command } from "@cliffy/command"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getIssueIdentifier } from "../../utils/linear.ts"
import { completeConnection } from "../../utils/pagination.ts"
import {
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"
import { withUsageMetadata } from "../usage.ts"

const issueAuditCurrentQuery = gql(`
  query GetIssueAuditCurrent($id: String!) {
    organization { id urlKey }
    issue(id: $id) {
      id
      identifier
      title
      url
      createdAt
      updatedAt
      archivedAt
      trashed
      priority
      estimate
      dueDate
      team { id key name }
      state { id name type color }
      assignee { id name displayName }
      project { id name slugId }
      projectMilestone { id name }
      cycle { id number name }
    }
  }
`)

const issueAuditHistoryQuery = gql(`
  query GetIssueAuditHistory($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      identifier
      history(first: $first, after: $after, orderBy: createdAt) {
        nodes {
          id
          createdAt
          updatedAt
          actor { id name displayName }
          botActor { id name type subType userDisplayName }
          changes
          archived
          trashed
          updatedDescription
          fromTitle
          toTitle
          fromPriority
          toPriority
          fromEstimate
          toEstimate
          fromDueDate
          toDueDate
          fromAssignee { id name displayName }
          toAssignee { id name displayName }
          fromState { id name type color }
          toState { id name type color }
          fromProject { id name slugId }
          toProject { id name slugId }
          fromProjectMilestone { id name }
          toProjectMilestone { id name }
          fromCycle { id number name }
          toCycle { id number name }
          fromParent { id identifier title }
          toParent { id identifier title }
          fromTeam { id key name }
          toTeam { id key name }
          fromDelegate { id name displayName }
          toDelegate { id name displayName }
          addedLabelIds
          removedLabelIds
          relationChanges { identifier type }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)

const DEFAULT_HISTORY_LIMIT = 50

type AuditEnvelope = Awaited<ReturnType<typeof readIssueAudit>>
type HistoryEntry = AuditEnvelope["history"]["nodes"][number]

/** Read the current issue and its history with separate GraphQL requests. */
export async function readIssueAudit(issueId: string, limit: number) {
  const client = getGraphQLClient()
  const current = await client.request(issueAuditCurrentQuery, { id: issueId })
  if (current.organization == null) {
    throw new ValidationError("Issue audit snapshot returned no organization")
  }
  if (current.issue == null) throw new NotFoundError("Issue", issueId)
  if (
    !current.issue.id || !current.issue.identifier ||
    !current.issue.createdAt || !current.issue.updatedAt
  ) {
    throw new ValidationError(
      "Issue audit snapshot returned incomplete identity",
    )
  }

  const historyIssueId = current.issue.id
  const first = limit > 0 ? Math.min(100, limit) : 100
  const fetchHistoryPage = async (after?: string, pageSize = first) => {
    const result = await client.request(issueAuditHistoryQuery, {
      id: historyIssueId,
      first: pageSize,
      after,
    })
    if (result.issue == null) {
      throw new ValidationError(`Could not read history for ${issueId}`)
    }
    return result.issue.history
  }
  const history = await completeConnection(
    await fetchHistoryPage(),
    fetchHistoryPage,
    `history for ${issueId}`,
    limit,
  )

  return {
    schemaVersion: 1,
    kind: "issue-audit" as const,
    organization: current.organization,
    issue: current.issue,
    history,
    audit: {
      consistency: "non-atomic" as const,
      reads: ["current issue", "issue history"],
      relations: "not-read",
      note:
        "The current issue and history were read through separate GraphQL requests; history may use additional requests for pagination, so this is not an atomic snapshot.",
    },
  }
}

export const auditCommand = withUsageMetadata(new Command(), {
  outputModes: ["human", "json"],
})
  .name("audit")
  .description("Read an issue snapshot and its paginated change history")
  .arguments("[issueId:string]")
  .option(
    "--limit <limit:number>",
    "Maximum history entries (default: 50, use 0 for all pages)",
    { default: DEFAULT_HISTORY_LIMIT },
  )
  .option("-j, --json", "Output the issue audit envelope as JSON")
  .action(async ({ json, limit }, issueId) => {
    try {
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new ValidationError("--limit must be a non-negative integer")
      }
      const resolvedIdentifier = await getIssueIdentifier(issueId)
      if (!resolvedIdentifier) {
        throw new ValidationError(
          "Could not determine issue identifier",
          { suggestion: "Please provide an issue identifier like 'ENG-123'." },
        )
      }

      const audit = await readIssueAudit(resolvedIdentifier, limit)
      if (json) {
        console.log(JSON.stringify(audit, null, 2))
        return
      }
      printHumanAudit(audit)
    } catch (error) {
      handleError(error, "Failed to audit issue")
    }
  })

function formatAuditValue(value: unknown): string {
  if (value == null) return "-"
  if (typeof value === "string" || typeof value === "number") {
    return String(value)
  }
  if (typeof value === "boolean") return value ? "true" : "false"
  if (Array.isArray(value)) return value.length === 0 ? "-" : value.join(", ")
  if (typeof value === "object") {
    const object = value as Record<string, unknown>
    for (const key of ["displayName", "name", "identifier", "key"]) {
      if (typeof object[key] === "string") return object[key]
    }
  }
  return JSON.stringify(value)
}

function appendHistoryPair(
  changes: string[],
  label: string,
  before: unknown,
  after: unknown,
): void {
  if (before == null && after == null) return
  changes.push(
    `${label}: ${formatAuditValue(before)} -> ${formatAuditValue(after)}`,
  )
}

function formatHistoryChanges(entry: HistoryEntry): string {
  const changes: string[] = []
  appendHistoryPair(changes, "title", entry.fromTitle, entry.toTitle)
  appendHistoryPair(changes, "priority", entry.fromPriority, entry.toPriority)
  appendHistoryPair(changes, "estimate", entry.fromEstimate, entry.toEstimate)
  appendHistoryPair(changes, "due date", entry.fromDueDate, entry.toDueDate)
  appendHistoryPair(changes, "assignee", entry.fromAssignee, entry.toAssignee)
  appendHistoryPair(changes, "state", entry.fromState, entry.toState)
  appendHistoryPair(changes, "project", entry.fromProject, entry.toProject)
  appendHistoryPair(
    changes,
    "milestone",
    entry.fromProjectMilestone,
    entry.toProjectMilestone,
  )
  appendHistoryPair(changes, "cycle", entry.fromCycle, entry.toCycle)
  appendHistoryPair(changes, "parent", entry.fromParent, entry.toParent)
  appendHistoryPair(changes, "team", entry.fromTeam, entry.toTeam)
  appendHistoryPair(changes, "delegate", entry.fromDelegate, entry.toDelegate)
  if (entry.archived != null) changes.push(`archived: ${entry.archived}`)
  if (entry.trashed != null) changes.push(`trashed: ${entry.trashed}`)
  if (entry.updatedDescription === true) changes.push("description updated")
  if (entry.addedLabelIds?.length) {
    changes.push(`labels added: ${entry.addedLabelIds.join(", ")}`)
  }
  if (entry.removedLabelIds?.length) {
    changes.push(`labels removed: ${entry.removedLabelIds.join(", ")}`)
  }
  if (entry.relationChanges?.length) {
    changes.push(`relations: ${JSON.stringify(entry.relationChanges)}`)
  }
  if (entry.changes != null) {
    changes.push(`changes: ${JSON.stringify(entry.changes)}`)
  }
  return changes.join("; ") || "metadata changed"
}

function historyActor(entry: HistoryEntry): string {
  if (entry.botActor != null) {
    const botType = entry.botActor.type ? `bot:${entry.botActor.type}` : "bot"
    const bot = entry.botActor.name
      ? `${entry.botActor.name}${entry.botActor.type ? ` (${botType})` : ""}`
      : botType
    return entry.botActor.userDisplayName
      ? `${bot} [user: ${entry.botActor.userDisplayName}]`
      : bot
  }
  return entry.actor?.displayName || entry.actor?.name || "system"
}

function printHumanAudit(audit: AuditEnvelope): void {
  const issue = audit.issue
  console.log(`Warning: audit.consistency=${audit.audit.consistency}`)
  console.log(`Note: ${audit.audit.note}`)
  console.log("")
  console.log("Current Snapshot")
  console.log(`Issue: ${issue.identifier} (${issue.id})`)
  console.log(`Title: ${issue.title}`)
  console.log(`State: ${formatAuditValue(issue.state)}`)
  console.log(`Assignee: ${formatAuditValue(issue.assignee)}`)
  console.log(`Team: ${formatAuditValue(issue.team)}`)
  console.log(`Project: ${formatAuditValue(issue.project)}`)
  console.log(`Priority: ${formatAuditValue(issue.priority)}`)
  console.log(`Estimate: ${formatAuditValue(issue.estimate)}`)
  console.log(`Due Date: ${formatAuditValue(issue.dueDate)}`)
  console.log(
    `Project Milestone: ${formatAuditValue(issue.projectMilestone)}`,
  )
  console.log(`Cycle: ${formatAuditValue(issue.cycle)}`)
  console.log(`Archived At: ${formatAuditValue(issue.archivedAt)}`)
  console.log(`Trashed: ${formatAuditValue(issue.trashed)}`)
  console.log(`Created: ${issue.createdAt}`)
  console.log(`Updated: ${issue.updatedAt}`)
  console.log(`URL: ${issue.url}`)
  console.log("")
  console.log("Change Log")
  if (audit.history.pageInfo.hasNextPage) {
    console.log(
      "Warning: history is truncated (Change Log is incomplete); increase --limit or use --limit 0 to fetch all history.",
    )
  }
  if (audit.history.nodes.length === 0) {
    console.log("No history found.")
    return
  }
  for (const entry of audit.history.nodes) {
    console.log(
      `${entry.createdAt} ${historyActor(entry)}: ${
        formatHistoryChanges(entry)
      }`,
    )
  }
}
