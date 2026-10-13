/**
 * Root fields with behavior beyond "look up by ID" or "list all": singletons,
 * search, and mutation semantics. Each mutation validates references like the
 * real API, records its write, and returns its payload.
 */
import type { GraphQLResolveInfo } from "graphql"
import { defaultState, nextIssueNumber } from "./defaults.ts"
import { normalizeLinearMarkdown } from "./markdown.ts"
import { LinearError } from "./errors.ts"
import { connectionOf, type Context, lookup, searchIssues } from "./resolve.ts"
import type { EntityRecord } from "./store.ts"

/** Natural keys an issue reference may use: its identifier, or an old one. */
const ISSUE_KEYS = ["identifier", "previousIdentifiers"]

type Args = Record<string, unknown>
type Input = Record<string, unknown>
type RootField = (args: Args, ctx: Context, info: GraphQLResolveInfo) => unknown

/** A root connection of the viewer's own records. */
function viewerConnection(
  ctx: Context,
  typename: string,
  ownerField: string,
  args: Args,
) {
  const viewer = ctx.store.viewer().id
  return connectionOf(
    ctx,
    ctx.store.all(typename).filter((record) => record[ownerField] === viewer),
    args,
  )
}

function ref(ctx: Context, typename: string, id: unknown): string | null {
  if (id == null) return null
  return lookup(ctx, typename, String(id)).id
}

function refs(ctx: Context, typename: string, ids: unknown): string[] {
  return (ids as unknown[]).map((id) => lookup(ctx, typename, String(id)).id)
}

/** Linear rewrites issue descriptions (not comment bodies); see markdown.ts. */
export function normalizeMarkdown(value: unknown): unknown {
  return typeof value === "string" ? normalizeLinearMarkdown(value) : value
}

/**
 * Observed on Kadoraba: creating with an empty description stores null, while
 * updating to an empty description stores "".
 */
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

function applyIssueInput(
  ctx: Context,
  issue: EntityRecord,
  input: Input,
  creating: boolean,
) {
  for (const key of ISSUE_SCALARS) {
    if (key in input) {
      issue[key] = key !== "description"
        ? input[key]
        : creating
        ? normalizeDescription(input[key])
        : normalizeMarkdown(input[key])
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
  applyIssueInput(ctx, issue, data, true)
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
  const issue = lookup(ctx, "Issue", String(id), ISSUE_KEYS)
  // A rejected input leaves the issue unchanged.
  const next = structuredClone(issue)
  if ("teamId" in data) {
    next.team = ref(ctx, "Team", data.teamId)
    if (next.team !== issue.team) {
      // Moving teams renumbers the issue; the old identifier still resolves.
      const team = ctx.store.find("Team", next.team as string)!
      next.previousIdentifiers = [
        ...((issue.previousIdentifiers as string[] | undefined) ?? []),
        issue.identifier,
      ]
      next.number = nextIssueNumber(ctx.store, team.id)
      next.identifier = `${team.key}-${next.number}`
    }
    // Moving teams without a state keeps the state's type in the new team.
    if (next.team !== issue.team && !("stateId" in data)) {
      const type = ctx.store.find("WorkflowState", issue.state as string)?.type
      const match = ctx.store.all("WorkflowState")
        .filter((state) => state.team === next.team && state.type === type)
        .sort((a, b) => Number(a.position) - Number(b.position))[0]
      next.state = match?.id ?? defaultState(ctx.store, next.team as string)
    }
  }
  applyIssueInput(ctx, next, data, false)
  Object.assign(issue, next)
  touch(ctx, issue)
  return payload(ctx, "issue", issue)
}

const issueDelete: RootField = ({ id, permanentlyDelete }, ctx) => {
  const issue = lookup(ctx, "Issue", String(id), ISSUE_KEYS)
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
    : lookup(ctx, "Issue", String(data.issueId), ISSUE_KEYS)
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
    // Observed on Kadoraba: comment bodies are stored verbatim.
    body: data.body ?? "",
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
    comment.body = data.body
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
// File upload: grants a signed PUT URL on the fake itself. The asset URL keeps
// Linear's host so the executable's host checks see a real-looking asset.

const fileUpload: RootField = (args, ctx) => {
  const id = ctx.store.newId()
  const org = ctx.store.singleton("Organization").id
  const host = args.makePublic === true
    ? "public.linear.app"
    : "uploads.linear.app"
  const assetUrl = `https://${host}/${org}/${id}/${id}`
  ctx.store.insert({
    id,
    __typename: "Upload",
    filename: args.filename,
    contentType: args.contentType,
    size: args.size,
    public: args.makePublic === true,
    assetUrl,
    received: false,
    createdAt: ctx.store.now(),
  })
  return {
    success: true,
    lastSyncId: ctx.store.nextSyncId(),
    uploadFile: {
      assetUrl,
      uploadUrl: `${ctx.origin}/upload/${id}`,
      headers: [{ key: "x-fake-upload", value: id }],
      contentType: args.contentType,
      filename: args.filename,
      size: args.size,
      metaData: args.metaData ?? null,
    },
  }
}

// ---------------------------------------------------------------------------
// Attachment: one per issue and URL; linking a known URL updates it.

function upsertAttachment(
  ctx: Context,
  issueRef: unknown,
  fields: Record<string, unknown>,
): EntityRecord {
  const issue = lookup(ctx, "Issue", String(issueRef), ISSUE_KEYS)
  const now = ctx.store.now()
  const existing = ctx.store.all("Attachment").find((attachment) =>
    attachment.issue === issue.id && attachment.url === fields.url
  )
  if (existing != null) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) existing[key] = value
    }
    existing.updatedAt = now
    return existing
  }
  return ctx.store.insert({
    id: ctx.store.newId(),
    __typename: "Attachment",
    issue: issue.id,
    subtitle: null,
    sourceType: "api",
    metadata: {},
    creator: ctx.store.viewer().id,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    ),
    // Linear derives a title from the linked page; the fake cannot fetch it.
    title: fields.title ?? fields.url,
  })
}

const attachmentLinkURL: RootField = ({ issueId, url, title }, ctx) =>
  payload(
    ctx,
    "attachment",
    upsertAttachment(ctx, issueId, { url, title: title ?? undefined }),
  )

const attachmentCreate: RootField = ({ input }, ctx) => {
  const data = input as Input
  rejectUnknown(
    data,
    ["id", "issueId", "url", "title", "subtitle", "metadata", "iconUrl"],
    "attachmentCreate",
  )
  return payload(
    ctx,
    "attachment",
    upsertAttachment(ctx, data.issueId, {
      url: data.url,
      title: data.title,
      subtitle: data.subtitle,
      metadata: data.metadata,
    }),
  )
}

// ---------------------------------------------------------------------------
// Favorite: the viewer's own; issue favorites take the issue's title and URL.

const favoriteCreate: RootField = ({ input }, ctx) => {
  const data = input as Input
  rejectUnknown(
    data,
    ["id", "issueId", "folderName", "parentId", "sortOrder"],
    "favoriteCreate",
  )
  const now = ctx.store.now()
  const issue = data.issueId == null
    ? null
    : lookup(ctx, "Issue", String(data.issueId), ISSUE_KEYS)
  const favorite = ctx.store.insert({
    id: typeof data.id === "string" ? data.id : ctx.store.newId(),
    __typename: "Favorite",
    type: issue == null ? "folder" : "issue",
    folderName: issue == null ? data.folderName ?? null : null,
    issue: issue?.id ?? null,
    parent: ref(ctx, "Favorite", data.parentId),
    owner: ctx.store.viewer().id,
    sortOrder: data.sortOrder ?? 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  })
  return payload(ctx, "favorite", favorite)
}

const favoriteDelete: RootField = ({ id }, ctx) => {
  const favorite = lookup(ctx, "Favorite", String(id))
  ctx.store.remove("Favorite", favorite.id)
  return {
    success: true,
    lastSyncId: ctx.store.nextSyncId(),
    entityId: favorite.id,
  }
}

// ---------------------------------------------------------------------------
// Issue relation

const issueRelationCreate: RootField = ({ input }, ctx) => {
  const data = input as Input
  rejectUnknown(
    data,
    ["id", "issueId", "relatedIssueId", "type"],
    "issueRelationCreate",
  )
  const issue = lookup(ctx, "Issue", String(data.issueId), ISSUE_KEYS)
  const related = lookup(ctx, "Issue", String(data.relatedIssueId), ISSUE_KEYS)
  if (issue.id === related.id) {
    throw LinearError.input(
      "Argument Validation Error",
      "An issue cannot be related to itself.",
    )
  }
  const now = ctx.store.now()
  const relation = ctx.store.insert({
    id: typeof data.id === "string" ? data.id : ctx.store.newId(),
    __typename: "IssueRelation",
    issue: issue.id,
    relatedIssue: related.id,
    type: data.type,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  })
  return payload(ctx, "issueRelation", relation)
}

const issueRelationDelete: RootField = ({ id }, ctx) => {
  const relation = lookup(ctx, "IssueRelation", String(id))
  ctx.store.remove("IssueRelation", relation.id)
  return {
    success: true,
    lastSyncId: ctx.store.nextSyncId(),
    entityId: relation.id,
  }
}

// ---------------------------------------------------------------------------
// Issue label

const issueLabelCreate: RootField = ({ input }, ctx) => {
  const data = input as Input
  rejectUnknown(
    data,
    ["id", "name", "color", "description", "teamId", "parentId", "isGroup"],
    "issueLabelCreate",
  )
  const team = ref(ctx, "Team", data.teamId)
  const name = String(data.name ?? "")
  const duplicate = ctx.store.all("IssueLabel").some((label) =>
    label.archivedAt == null && label.team === team &&
    String(label.name).toLowerCase() === name.toLowerCase()
  )
  if (duplicate) {
    throw LinearError.input(
      "duplicate label name",
      "A label with this name already exists.",
    )
  }
  const now = ctx.store.now()
  const label = ctx.store.insert({
    id: typeof data.id === "string" ? data.id : ctx.store.newId(),
    __typename: "IssueLabel",
    name,
    color: data.color ?? "#bec2c8",
    description: data.description ?? null,
    team,
    parent: ref(ctx, "IssueLabel", data.parentId),
    isGroup: data.isGroup ?? false,
    creator: ctx.store.viewer().id,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  })
  return payload(ctx, "issueLabel", label)
}

const issueLabelDelete: RootField = ({ id }, ctx) => {
  const label = lookup(ctx, "IssueLabel", String(id))
  ctx.store.remove("IssueLabel", label.id)
  for (const issue of ctx.store.all("Issue")) {
    if (Array.isArray(issue.labels)) {
      issue.labels = issue.labels.filter((labelId) => labelId !== label.id)
    }
  }
  return {
    success: true,
    lastSyncId: ctx.store.nextSyncId(),
    entityId: label.id,
  }
}

// ---------------------------------------------------------------------------

export function rootValue(): Record<string, RootField> {
  return {
    viewer: (_, ctx) => ctx.store.viewer(),
    organization: (_, ctx) => ctx.store.singleton("Organization"),
    userSettings: (_, ctx) => ctx.store.singleton("UserSettings"),
    searchIssues: (args, ctx) => searchIssues(ctx, args),
    favorites: (args, ctx) => viewerConnection(ctx, "Favorite", "owner", args),
    issueCreate,
    issueUpdate,
    issueDelete,
    fileUpload,
    attachmentLinkURL,
    attachmentCreate,
    favoriteCreate,
    favoriteDelete,
    issueRelationCreate,
    issueRelationDelete,
    issueLabelCreate,
    issueLabelDelete,
    commentCreate,
    commentUpdate,
    commentDelete,
    commentResolve,
    commentUnresolve,
  }
}
