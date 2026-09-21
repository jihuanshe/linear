/**
 * Context summary shown before an Issue body. It surfaces the facts a reader
 * otherwise has to remember to query: parent, sub-issues, relations,
 * attachments, comments by other accounts, and recent state or ownership
 * changes by other accounts. Nothing here decides anything; it only puts the
 * evidence in front of the caller.
 */
import { gql } from "../__codegen__/gql.ts"
import { getGraphQLClient } from "./graphql.ts"
import { NotFoundError } from "./errors.ts"

/** Recent history with the actor and the state / ownership transitions. */
export const issueHistoryPreviewFragment = gql(`
  fragment IssueHistoryPreview on Issue {
    history(first: 50, orderBy: createdAt) {
      nodes {
        id
        createdAt
        actor { id name displayName }
        botActor { name type userDisplayName }
        fromState { name }
        toState { name }
        fromAssignee { id name displayName }
        toAssignee { id name displayName }
        fromProject { name }
        toProject { name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

const issueContextQuery = gql(`
  query GetIssueContext($id: String!) {
    viewer { id }
    issue(id: $id) {
      id
      identifier
      assignee { id name displayName }
      parent { identifier title state { name } }
      children(first: 250) {
        nodes { identifier title state { name } }
        pageInfo { hasNextPage }
      }
      relations(first: 250) {
        nodes { id type relatedIssue { identifier title } }
        pageInfo { hasNextPage }
      }
      inverseRelations(first: 250) {
        nodes { id type issue { identifier title } }
        pageInfo { hasNextPage }
      }
      attachments(first: 50) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
      comments(first: 50, orderBy: createdAt) {
        nodes {
          id
          createdAt
          resolvedAt
          user { id name displayName }
          externalUser { name displayName }
          parent { id }
        }
        pageInfo { hasNextPage endCursor }
      }
      ...IssueHistoryPreview
    }
  }
`)

interface Person {
  id?: string | null
  name?: string | null
  displayName?: string | null
}

interface IssueRef {
  identifier: string
  title: string
  state: { name: string }
}

interface RelatedIssueRef {
  identifier: string
  title: string
}

interface HistoryNode {
  createdAt: string
  actor?: Person | null
  botActor?: { name?: string | null; userDisplayName?: string | null } | null
  fromState?: { name: string } | null
  toState?: { name: string } | null
  fromAssignee?: Person | null
  toAssignee?: Person | null
  fromProject?: { name: string } | null
  toProject?: { name: string } | null
}

interface CommentNode {
  createdAt: string
  resolvedAt?: string | null
  user?: Person | null
  externalUser?: Person | null
  parent?: { id: string } | null
}

type Connection<T> =
  | {
    nodes: ReadonlyArray<T>
    pageInfo?: { hasNextPage: boolean } | null
  }
  | null
  | undefined

/**
 * Structural input shared by `issue view` reads and the preflight query.
 * Every collection is optional so a partial read degrades to "not fetched"
 * instead of failing.
 */
export interface IssueContextInput {
  viewer?: { id: string } | null
  issue: {
    identifier: string
    assignee?: Person | null
    parent?: IssueRef | null
    children?: Connection<IssueRef>
    relations?: Connection<
      { type: string; relatedIssue: RelatedIssueRef | null }
    >
    inverseRelations?: Connection<
      { type: string; issue: RelatedIssueRef | null }
    >
    attachments?: Connection<unknown>
    comments?: Connection<CommentNode>
    history?: Connection<HistoryNode>
  }
}

export type IssueRelationKind =
  | "blocks"
  | "blocked by"
  | "duplicate of"
  | "duplicated by"
  | "related"
  | "similar"

export interface IssueContextSummary {
  /** Null when the read did not include the viewer. */
  viewerId: string | null
  assignee: { id: string | null; name: string } | null
  /** Null when either side is unknown. */
  viewerIsAssignee: boolean | null
  parent: { identifier: string; title: string; state: string } | null
  subIssues: {
    fetched: boolean
    count: number
    complete: boolean
    byState: Record<string, number>
    items: Array<{ identifier: string; state: string }>
  }
  relations: {
    fetched: boolean
    complete: boolean
    items: Array<{ kind: IssueRelationKind; identifier: string; title: string }>
  }
  attachments: { fetched: boolean; count: number; complete: boolean }
  comments: {
    fetched: boolean
    count: number
    complete: boolean
    unresolvedThreads: number
    byOtherAccounts: number
    latestByOtherAccount: { author: string; createdAt: string } | null
  }
  history: {
    fetched: boolean
    entries: number
    complete: boolean
    changesByOtherAccounts: Array<{
      createdAt: string
      actor: string
      changes: string[]
    }>
  }
}

function personName(person: Person | null | undefined): string | null {
  return person?.displayName || person?.name || null
}

function isViewer(
  viewerId: string | null,
  person: Person | null | undefined,
): boolean {
  return viewerId != null && person?.id != null && person.id === viewerId
}

function historyActor(entry: HistoryNode): string {
  const human = personName(entry.actor)
  if (human != null) return human
  if (entry.botActor != null) {
    const bot = entry.botActor.name ?? "bot"
    return entry.botActor.userDisplayName
      ? `${bot} [user: ${entry.botActor.userDisplayName}]`
      : bot
  }
  return "system"
}

function transition(
  label: string,
  from: string | null | undefined,
  to: string | null | undefined,
): string | null {
  if (from == null && to == null) return null
  return `${label} ${from ?? "-"} -> ${to ?? "-"}`
}

function relationKind(
  type: string,
  direction: "outgoing" | "incoming",
): IssueRelationKind {
  switch (type) {
    case "blocks":
      return direction === "outgoing" ? "blocks" : "blocked by"
    case "duplicate":
      return direction === "outgoing" ? "duplicate of" : "duplicated by"
    case "similar":
      return "similar"
    default:
      return "related"
  }
}

export function summarizeIssueContext(
  input: IssueContextInput,
): IssueContextSummary {
  const viewerId = input.viewer?.id ?? null
  const { issue } = input
  const assignee = issue.assignee == null ? null : {
    id: issue.assignee.id ?? null,
    name: personName(issue.assignee) ?? "unknown",
  }
  const viewerIsAssignee = viewerId == null || assignee == null
    ? (viewerId != null && assignee == null ? false : null)
    : assignee.id === viewerId

  const children = issue.children
  const byState: Record<string, number> = {}
  const items: Array<{ identifier: string; state: string }> = []
  for (const child of children?.nodes ?? []) {
    byState[child.state.name] = (byState[child.state.name] ?? 0) + 1
    items.push({ identifier: child.identifier, state: child.state.name })
  }

  const relations: IssueContextSummary["relations"]["items"] = []
  for (const relation of issue.relations?.nodes ?? []) {
    if (relation.relatedIssue == null) continue
    relations.push({
      kind: relationKind(relation.type, "outgoing"),
      identifier: relation.relatedIssue.identifier,
      title: relation.relatedIssue.title,
    })
  }
  for (const relation of issue.inverseRelations?.nodes ?? []) {
    if (relation.issue == null) continue
    relations.push({
      kind: relationKind(relation.type, "incoming"),
      identifier: relation.issue.identifier,
      title: relation.issue.title,
    })
  }

  const comments = issue.comments
  let byOtherAccounts = 0
  let latestByOtherAccount: { author: string; createdAt: string } | null = null
  let unresolvedThreads = 0
  for (const comment of comments?.nodes ?? []) {
    if (comment.parent == null && comment.resolvedAt == null) {
      unresolvedThreads += 1
    }
    if (isViewer(viewerId, comment.user)) continue
    byOtherAccounts += 1
    const author = personName(comment.user) ??
      personName(comment.externalUser) ??
      "unknown"
    if (
      latestByOtherAccount == null ||
      new Date(comment.createdAt).getTime() >
        new Date(latestByOtherAccount.createdAt).getTime()
    ) {
      latestByOtherAccount = { author, createdAt: comment.createdAt }
    }
  }

  const history = issue.history
  const changesByOtherAccounts: IssueContextSummary["history"][
    "changesByOtherAccounts"
  ] = []
  for (const entry of history?.nodes ?? []) {
    if (isViewer(viewerId, entry.actor)) continue
    const changes = [
      transition("state", entry.fromState?.name, entry.toState?.name),
      transition(
        "assignee",
        personName(entry.fromAssignee),
        personName(entry.toAssignee),
      ),
      transition("project", entry.fromProject?.name, entry.toProject?.name),
    ].filter((change): change is string => change != null)
    if (changes.length === 0) continue
    changesByOtherAccounts.push({
      createdAt: entry.createdAt,
      actor: historyActor(entry),
      changes,
    })
  }

  return {
    viewerId,
    assignee,
    viewerIsAssignee,
    parent: issue.parent == null ? null : {
      identifier: issue.parent.identifier,
      title: issue.parent.title,
      state: issue.parent.state.name,
    },
    subIssues: {
      fetched: children != null,
      count: children?.nodes.length ?? 0,
      complete: children != null && children.pageInfo?.hasNextPage !== true,
      byState,
      items,
    },
    relations: {
      fetched: issue.relations != null || issue.inverseRelations != null,
      complete: issue.relations?.pageInfo?.hasNextPage !== true &&
        issue.inverseRelations?.pageInfo?.hasNextPage !== true,
      items: relations,
    },
    attachments: {
      fetched: issue.attachments != null,
      count: issue.attachments?.nodes.length ?? 0,
      complete: issue.attachments != null &&
        issue.attachments.pageInfo?.hasNextPage !== true,
    },
    comments: {
      fetched: comments != null,
      count: comments?.nodes.length ?? 0,
      complete: comments != null && comments.pageInfo?.hasNextPage !== true,
      unresolvedThreads,
      byOtherAccounts,
      latestByOtherAccount,
    },
    history: {
      fetched: history != null,
      entries: history?.nodes.length ?? 0,
      complete: history != null && history.pageInfo?.hasNextPage !== true,
      changesByOtherAccounts,
    },
  }
}

/** Evidence that another account or a wider structure depends on this Issue. */
export function issueContextTraces(summary: IssueContextSummary): string[] {
  const traces: string[] = []
  if (summary.subIssues.count > 0) traces.push("sub-issues")
  if (summary.parent != null) traces.push("a parent issue")
  if (summary.relations.items.length > 0) traces.push("relations")
  if (summary.history.changesByOtherAccounts.length > 0) {
    traces.push("state or ownership changes by other accounts")
  }
  if (summary.comments.byOtherAccounts > 0) {
    traces.push("comments by other accounts")
  }
  return traces
}

function countWithCompleteness(count: number, complete: boolean): string {
  return complete ? String(count) : `${count}+`
}

function shortDate(iso: string): string {
  return iso.length >= 16 ? iso.slice(0, 16).replace("T", " ") : iso
}

/**
 * Markdown list lines. They read the same in a terminal, in piped Markdown
 * and on stderr.
 */
export function formatIssueContextLines(
  summary: IssueContextSummary,
): string[] {
  const lines: string[] = []

  const assigneeLabel = summary.assignee == null
    ? "Unassigned"
    : `@${summary.assignee.name}`
  const ownership = summary.viewerIsAssignee == null
    ? ""
    : summary.viewerIsAssignee
    ? " (the current account)"
    : summary.assignee == null
    ? ""
    : " (not the current account)"
  lines.push(`- Assignee: ${assigneeLabel}${ownership}`)

  const parentLine = summary.parent == null
    ? "- Parent: none"
    : `- Parent: ${summary.parent.identifier} ${summary.parent.title} [${summary.parent.state}]`

  let subIssuesLine: string

  if (!summary.subIssues.fetched) {
    subIssuesLine = "- Sub-issues: not fetched"
  } else if (summary.subIssues.count === 0) {
    subIssuesLine = "- Sub-issues: none"
  } else {
    const states = Object.entries(summary.subIssues.byState)
      .map(([state, count]) => `${state} ${count}`)
      .join(", ")
    const identifiers = summary.subIssues.items
      .map((item) => item.identifier)
      .join(", ")
    subIssuesLine = `- Sub-issues: ${
      countWithCompleteness(
        summary.subIssues.count,
        summary.subIssues.complete,
      )
    } (${states}): ${identifiers}`
  }

  let relationsLine: string

  if (!summary.relations.fetched) {
    relationsLine = "- Relations: not fetched"
  } else if (summary.relations.items.length === 0) {
    relationsLine = "- Relations: none"
  } else {
    const described = summary.relations.items
      .map((item) => `${item.kind} ${item.identifier}`)
      .join("; ")
    relationsLine = `- Relations: ${described}${
      summary.relations.complete ? "" : " (more not fetched)"
    }`
  }

  // Three empty facts collapse into one line so an empty Context stays short.
  if (
    parentLine === "- Parent: none" &&
    subIssuesLine === "- Sub-issues: none" &&
    relationsLine === "- Relations: none"
  ) {
    lines.push("- Parent / Sub-issues / Relations: none")
  } else {
    lines.push(parentLine, subIssuesLine, relationsLine)
  }

  const attachments = summary.attachments.fetched
    ? countWithCompleteness(
      summary.attachments.count,
      summary.attachments.complete,
    )
    : "not fetched"
  if (!summary.comments.fetched) {
    lines.push(`- Attachments: ${attachments} | Comments: not fetched`)
  } else {
    const commentCount = countWithCompleteness(
      summary.comments.count,
      summary.comments.complete,
    )
    const others = summary.comments.byOtherAccounts === 0
      ? "none by other accounts"
      : `${summary.comments.byOtherAccounts} by other accounts, latest @${summary.comments.latestByOtherAccount?.author} ${
        shortDate(summary.comments.latestByOtherAccount?.createdAt ?? "")
      }`
    lines.push(
      `- Attachments: ${attachments} | Comments: ${commentCount} (${summary.comments.unresolvedThreads} unresolved threads; ${others})`,
    )
  }

  if (!summary.history.fetched) {
    lines.push("- Changes by other accounts: history not fetched")
  } else {
    const scope = summary.history.complete
      ? `all ${summary.history.entries} history entries`
      : `latest ${summary.history.entries} history entries; older ones exist, see issue history`
    if (summary.history.changesByOtherAccounts.length === 0) {
      lines.push(`- Changes by other accounts: none (${scope})`)
    } else {
      lines.push(`- Changes by other accounts (${scope}):`)
      for (const change of summary.history.changesByOtherAccounts) {
        lines.push(
          `  - ${shortDate(change.createdAt)} @${change.actor}: ${
            change.changes.join("; ")
          }`,
        )
      }
    }
  }

  return lines
}

export function formatIssueContextMarkdown(
  summary: IssueContextSummary,
): string {
  return `## Context\n\n${formatIssueContextLines(summary).join("\n")}\n`
}

/** One read for callers that do not already hold `issue view` data. */
export async function fetchIssueContext(
  issueReference: string,
): Promise<IssueContextSummary> {
  const data = await getGraphQLClient().request(issueContextQuery, {
    id: issueReference,
  })
  if (data.issue == null) throw new NotFoundError("Issue", issueReference)
  return summarizeIssueContext(data)
}
