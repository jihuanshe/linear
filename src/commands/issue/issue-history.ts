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

const issueHistoryQuery = gql(`
  query GetIssueHistory($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      id
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
          autoArchived
          autoClosed
          attachment { id title url }
          attachmentId
          updatedDescription
          descriptionUpdatedBy { id name displayName }
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
          toConvertedProject { id name slugId }
          toConvertedProjectId
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
          fromSlaBreached
          toSlaBreached
          fromSlaBreachesAt
          toSlaBreachesAt
          fromSlaStartedAt
          toSlaStartedAt
          fromSlaType
          toSlaType
          addedToReleaseIds
          removedFromReleaseIds
          addedLabelIds
          removedLabelIds
          relationChanges { identifier type }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)

type HistoryEntry = Awaited<
  ReturnType<typeof readIssueHistory>
>["nodes"][number]

async function readIssueHistory(issueId: string, limit: number) {
  const client = getGraphQLClient()
  const first = limit > 0 ? Math.min(100, limit) : 100
  const initial = await client.request(issueHistoryQuery, {
    id: issueId,
    first,
  })
  if (initial.issue == null) throw new NotFoundError("Issue", issueId)
  if (!initial.issue.id) {
    throw new ValidationError(`Issue history returned no ID for ${issueId}`)
  }

  // An identifier can change when the issue moves teams. Keep its UUID for
  // every subsequent page rather than resolving the identifier again.
  const historyIssueId = initial.issue.id
  return await completeConnection(
    initial.issue.history,
    async (after, pageSize) => {
      const result = await client.request(issueHistoryQuery, {
        id: historyIssueId,
        first: pageSize,
        after,
      })
      if (result.issue == null) {
        throw new ValidationError(`Could not read history for ${issueId}`)
      }
      if (result.issue.id !== historyIssueId) {
        throw new ValidationError(
          `Issue history changed target: ${issueId}`,
        )
      }
      return result.issue.history
    },
    `history for ${issueId}`,
    limit,
  )
}

export const historyCommand = new Command()
  .name("history")
  .description(
    "Show upstream issue history (all pages by default). Not every write produces a separate entry; use view for current state and write receipts for reconciliation.",
  )
  .arguments("[issueId:string]")
  .option(
    "--limit <limit:number>",
    "Maximum history entries (0 for all pages)",
    { default: 0 },
  )
  .option("-j, --json", "Output history as a JSON connection")
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

      const history = await readIssueHistory(resolvedIdentifier, limit)
      if (json) {
        console.log(JSON.stringify(history, null, 2))
        return
      }
      if (history.pageInfo.hasNextPage) {
        console.log(
          "Warning: history is truncated; increase --limit or use --limit 0 to fetch all history.",
        )
      }
      if (history.nodes.length === 0) {
        console.log(`No history found for ${resolvedIdentifier}`)
        return
      }
      for (const entry of history.nodes) {
        console.log(
          `${entry.createdAt} ${historyActor(entry)}: ${
            formatHistoryChanges(entry)
          }`,
        )
      }
    } catch (error) {
      handleError(error, "Failed to read issue history")
    }
  })

function formatHistoryValue(value: unknown): string {
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

function formatCycle(value: unknown): string {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    const cycle = value as Record<string, unknown>
    if (typeof cycle.name === "string" && cycle.name.length > 0) {
      return cycle.name
    }
    if (typeof cycle.number === "number") return `Cycle ${cycle.number}`
  }
  return formatHistoryValue(value)
}

function formatAttachment(attachment: unknown, attachmentId: unknown): string {
  const details = attachment != null && typeof attachment === "object" &&
      !Array.isArray(attachment)
    ? attachment as Record<string, unknown>
    : null
  const id = typeof attachmentId === "string"
    ? attachmentId
    : typeof details?.id === "string"
    ? details.id
    : null
  const title = typeof details?.title === "string" ? details.title : null
  const url = typeof details?.url === "string" ? details.url : null
  const label = title ?? id ?? "unknown attachment"
  const identity = title != null && id != null ? ` (${id})` : ""
  const location = url == null ? "" : ` - ${url}`
  return `${label}${identity}${location}`
}

function appendHistoryPair(
  changes: string[],
  label: string,
  before: unknown,
  after: unknown,
  formatValue: (value: unknown) => string = formatHistoryValue,
): void {
  if (before == null && after == null) return
  changes.push(
    `${label}: ${formatValue(before)} -> ${formatValue(after)}`,
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
  if (entry.toConvertedProject != null || entry.toConvertedProjectId != null) {
    const convertedProjectId = entry.toConvertedProjectId ??
      entry.toConvertedProject?.id
    changes.push(
      `converted to project: ${formatHistoryValue(entry.toConvertedProject)}${
        convertedProjectId == null ? "" : ` (${convertedProjectId})`
      }`,
    )
  }
  appendHistoryPair(
    changes,
    "milestone",
    entry.fromProjectMilestone,
    entry.toProjectMilestone,
  )
  appendHistoryPair(
    changes,
    "cycle",
    entry.fromCycle,
    entry.toCycle,
    formatCycle,
  )
  appendHistoryPair(changes, "parent", entry.fromParent, entry.toParent)
  appendHistoryPair(changes, "team", entry.fromTeam, entry.toTeam)
  appendHistoryPair(changes, "delegate", entry.fromDelegate, entry.toDelegate)
  appendHistoryPair(
    changes,
    "SLA breached",
    entry.fromSlaBreached,
    entry.toSlaBreached,
  )
  appendHistoryPair(
    changes,
    "SLA breaches at",
    entry.fromSlaBreachesAt,
    entry.toSlaBreachesAt,
  )
  appendHistoryPair(
    changes,
    "SLA started at",
    entry.fromSlaStartedAt,
    entry.toSlaStartedAt,
  )
  appendHistoryPair(changes, "SLA type", entry.fromSlaType, entry.toSlaType)
  if (entry.addedToReleaseIds?.length) {
    changes.push(`releases added: ${entry.addedToReleaseIds.join(", ")}`)
  }
  if (entry.removedFromReleaseIds?.length) {
    changes.push(`releases removed: ${entry.removedFromReleaseIds.join(", ")}`)
  }
  if (entry.archived != null) changes.push(`archived: ${entry.archived}`)
  if (entry.trashed != null) changes.push(`trashed: ${entry.trashed}`)
  if (entry.autoArchived === true) changes.push("automatically archived")
  if (entry.autoClosed === true) changes.push("automatically closed")
  if (entry.attachment != null || entry.attachmentId != null) {
    changes.push(
      `attachment: ${formatAttachment(entry.attachment, entry.attachmentId)}`,
    )
  }
  if (entry.updatedDescription === true) {
    const editors = entry.descriptionUpdatedBy?.map(formatHistoryValue).filter(
      (editor) => editor !== "-",
    )
    changes.push(
      editors?.length
        ? `description updated by: ${editors.join(", ")}`
        : "description updated",
    )
  }
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
