/**
 * Root fields with behavior beyond "look up by ID" or "list all": singletons,
 * search, and mutation semantics. Each mutation validates references like the
 * real API, records its write, and returns its payload.
 */
import type { GraphQLResolveInfo } from "graphql"
import { defaultState, nextIssueNumber } from "./defaults.ts"
import { LinearError } from "./errors.ts"
import { type Context, lookup } from "./resolve.ts"
import type { EntityRecord } from "./store.ts"

type Args = Record<string, unknown>
type Input = Record<string, unknown>
type RootField = (args: Args, ctx: Context, info: GraphQLResolveInfo) => unknown

function ref(ctx: Context, typename: string, id: unknown): string | null {
  if (id == null) return null
  return lookup(ctx, typename, String(id)).id
}

function refs(ctx: Context, typename: string, ids: unknown): string[] {
  return (ids as unknown[]).map((id) => lookup(ctx, typename, String(id)).id)
}

/** Linear stores Markdown without trailing newlines (observed on Kadoraba). */
export function normalizeMarkdown(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/\n+$/, "") : value
}

/** Observed on Kadoraba: an empty issue description is stored as null. */
function normalizeDescription(value: unknown): unknown {
  const text = normalizeMarkdown(value)
  return text === "" ? null : text
}

function touch(ctx: Context, record: EntityRecord): void {
  record.updatedAt = ctx.store.now()
}

function payload(ctx: Context, field: string, record: EntityRecord) {
  return { success: true, lastSyncId: ctx.store.nextSyncId(), [field]: record }
}

function rejectUnknown(input: Input, known: readonly string[], where: string) {
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) {
      throw new Error(`fake: ${where} input field ${key} is not implemented`)
    }
  }
}

// ---------------------------------------------------------------------------
// Issue

const ISSUE_SCALARS = [
  "title",
  "description",
  "priority",
  "estimate",
  "dueDate",
  "sortOrder",
] as const

const ISSUE_REFS = {
  assigneeId: ["assignee", "User"],
  stateId: ["state", "WorkflowState"],
  parentId: ["parent", "Issue"],
  projectId: ["project", "Project"],
  projectMilestoneId: ["projectMilestone", "ProjectMilestone"],
  cycleId: ["cycle", "Cycle"],
  delegateId: ["delegate", "User"],
} as const

function applyIssueInput(ctx: Context, issue: EntityRecord, input: Input) {
  for (const key of ISSUE_SCALARS) {
    if (key in input) {
      issue[key] = key === "description"
        ? normalizeDescription(input[key])
        : input[key]
    }
  }
  for (const [key, [field, typename]] of Object.entries(ISSUE_REFS)) {
    if (key in input) issue[field] = ref(ctx, typename, input[key])
  }
  if ("labelIds" in input) {
    issue.labels = refs(ctx, "IssueLabel", input.labelIds)
  }
  if ("addedLabelIds" in input) {
    const labels = new Set(issue.labels as string[])
    for (const id of refs(ctx, "IssueLabel", input.addedLabelIds)) {
      labels.add(id)
    }
    issue.labels = [...labels]
  }
  if ("removedLabelIds" in input) {
    const removed = new Set(refs(ctx, "IssueLabel", input.removedLabelIds))
    issue.labels = (issue.labels as string[]).filter((id) => !removed.has(id))
  }
  if ("subscriberIds" in input) {
    issue.subscribers = refs(ctx, "User", input.subscriberIds)
  }
  if (issue.state != null) {
    const state = ctx.store.find("WorkflowState", issue.state as string)
    if (state?.team !== issue.team) {
      throw LinearError.input(
        "Argument Validation Error",
        "The workflow state does not belong to the issue's team.",
      )
    }
  }
}

const issueCreate: RootField = ({ input }, ctx) => {
  const data = input as Input
  rejectUnknown(
    data,
    [
      "id",
      "teamId",
      "labelIds",
      "subscriberIds",
      // The world defines no templates, so applying the default is a no-op.
      "useDefaultTemplate",
      ...ISSUE_SCALARS,
      ...Object.keys(ISSUE_REFS),
    ],
    "issueCreate",
  )
  const team = lookup(ctx, "Team", String(data.teamId))
  const number = nextIssueNumber(ctx.store, team.id)
  const now = ctx.store.now()
  const issue: EntityRecord = {
    id: typeof data.id === "string" ? data.id : ctx.store.newId(),
    __typename: "Issue",
    number,
    identifier: `${team.key}-${number}`,
    team: team.id,
    title: "",
    description: null,
    priority: 0,
    estimate: null,
    dueDate: null,
    sortOrder: 0,
    labels: [],
    subscribers: [ctx.store.viewer().id],
    creator: ctx.store.viewer().id,
    assignee: null,
    parent: null,
    project: null,
    projectMilestone: null,
    cycle: null,
    state: defaultState(ctx.store, team.id),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    canceledAt: null,
    completedAt: null,
    startedAt: null,
    trashed: null,
  }
  // Observed on Kadoraba: creating an issue records no history entry.
  applyIssueInput(ctx, issue, data)
  ctx.store.insert(issue)
  return payload(ctx, "issue", issue)
}

const issueUpdate: RootField = ({ id, input }, ctx) => {
  const data = input as Input
  rejectUnknown(
    data,
    [
      "teamId",
      "labelIds",
      "addedLabelIds",
      "removedLabelIds",
      "subscriberIds",
      ...ISSUE_SCALARS,
      ...Object.keys(ISSUE_REFS),
    ],
    "issueUpdate",
  )
  const issue = lookup(ctx, "Issue", String(id), ["identifier"])
  // A rejected input leaves the issue unchanged.
  const next = structuredClone(issue)
  if ("teamId" in data) next.team = ref(ctx, "Team", data.teamId)
  applyIssueInput(ctx, next, data)
  Object.assign(issue, next)
  touch(ctx, issue)
  return payload(ctx, "issue", issue)
}

const issueDelete: RootField = ({ id, permanentlyDelete }, ctx) => {
  const issue = lookup(ctx, "Issue", String(id), ["identifier"])
  if (permanentlyDelete === true) {
    ctx.store.remove("Issue", issue.id)
  } else {
    const now = ctx.store.now()
    issue.archivedAt = now
    issue.trashed = true
    // Observed on Kadoraba: trashing records one entry with trashed: true.
    ctx.store.insert({
      id: ctx.store.newId(),
      __typename: "IssueHistory",
      issue: issue.id,
      actor: ctx.store.viewer().id,
      trashed: true,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })
  }
  return {
    success: true,
    lastSyncId: ctx.store.nextSyncId(),
    entity: issue,
  }
}

// ---------------------------------------------------------------------------
// Comment

const commentCreate: RootField = ({ input }, ctx) => {
  const data = input as Input
  rejectUnknown(
    data,
    [
      "id",
      "issueId",
      "documentContentId",
      "parentId",
      "body",
      "quotedText",
      "doNotSubscribeToIssue",
    ],
    "commentCreate",
  )
  const issue = data.issueId == null
    ? null
    : lookup(ctx, "Issue", String(data.issueId), ["identifier"])
  const parent = data.parentId == null
    ? null
    : lookup(ctx, "Comment", String(data.parentId))
  if (issue == null && data.documentContentId == null && parent == null) {
    throw LinearError.input(
      "Argument Validation Error",
      "A comment needs a parent entity.",
    )
  }
  const now = ctx.store.now()
  const comment = ctx.store.insert({
    id: typeof data.id === "string" ? data.id : ctx.store.newId(),
    __typename: "Comment",
    body: normalizeMarkdown(data.body ?? ""),
    issue: issue?.id ?? parent?.issue ?? null,
    documentContentId: data.documentContentId ?? parent?.documentContentId ??
      null,
    parent: parent?.id ?? null,
    quotedText: data.quotedText ?? null,
    user: ctx.store.viewer().id,
    resolvedAt: null,
    resolvingUser: null,
    resolvingComment: null,
    editedAt: null,
    reactionData: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  })
  return payload(ctx, "comment", comment)
}

const commentUpdate: RootField = ({ id, input }, ctx) => {
  const data = input as Input
  rejectUnknown(data, ["body", "quotedText"], "commentUpdate")
  const comment = lookup(ctx, "Comment", String(id))
  if ("body" in data) {
    comment.body = normalizeMarkdown(data.body)
    comment.editedAt = ctx.store.now()
  }
  if ("quotedText" in data) comment.quotedText = data.quotedText
  touch(ctx, comment)
  return payload(ctx, "comment", comment)
}

const commentDelete: RootField = ({ id }, ctx) => {
  const comment = lookup(ctx, "Comment", String(id))
  for (const reply of ctx.store.all("Comment")) {
    if (reply.parent === comment.id) ctx.store.remove("Comment", reply.id)
  }
  ctx.store.remove("Comment", comment.id)
  return {
    success: true,
    lastSyncId: ctx.store.nextSyncId(),
    entityId: comment.id,
  }
}

const commentResolve: RootField = ({ id, resolvingCommentId }, ctx) => {
  const comment = lookup(ctx, "Comment", String(id))
  const resolving = resolvingCommentId == null
    ? null
    : lookup(ctx, "Comment", String(resolvingCommentId))
  comment.resolvedAt = ctx.store.now()
  comment.resolvingUser = ctx.store.viewer().id
  comment.resolvingComment = resolving?.id ?? null
  touch(ctx, comment)
  return payload(ctx, "comment", comment)
}

const commentUnresolve: RootField = ({ id }, ctx) => {
  const comment = lookup(ctx, "Comment", String(id))
  comment.resolvedAt = null
  comment.resolvingUser = null
  comment.resolvingComment = null
  touch(ctx, comment)
  return payload(ctx, "comment", comment)
}

// ---------------------------------------------------------------------------

export function rootValue(): Record<string, RootField> {
  return {
    viewer: (_, ctx) => ctx.store.viewer(),
    organization: (_, ctx) => ctx.store.singleton("Organization"),
    userSettings: (_, ctx) => ctx.store.singleton("UserSettings"),
    issueCreate,
    issueUpdate,
    issueDelete,
    commentCreate,
    commentUpdate,
    commentDelete,
    commentResolve,
    commentUnresolve,
  }
}
