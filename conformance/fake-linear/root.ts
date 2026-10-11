/**
 * Root fields with behavior beyond "look up by ID" or "list all": singletons,
 * search, and mutation semantics. Each mutation validates references like the
 * real API, records its write, and returns its payload.
 */
import type { GraphQLResolveInfo } from "graphql"
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
        ? normalizeMarkdown(input[key])
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

function defaultState(ctx: Context, teamId: string): string {
  const team = ctx.store.find("Team", teamId)!
  if (typeof team.defaultIssueState === "string") return team.defaultIssueState
  const states = ctx.store.all("WorkflowState")
    .filter((state) => state.team === teamId && state.type === "backlog")
    .sort((a, b) => Number(a.position) - Number(b.position))
  if (states[0] == null) throw new Error("fake: team has no backlog state")
  return states[0].id
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
  const number = ctx.store.all("Issue")
    .filter((issue) => issue.team === team.id)
    .reduce((max, issue) => Math.max(max, Number(issue.number)), 0) + 1
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
    state: defaultState(ctx, team.id),
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

export function rootValue(): Record<string, RootField> {
  return {
    viewer: (_, ctx) => ctx.store.viewer(),
    organization: (_, ctx) => ctx.store.singleton("Organization"),
    issueCreate,
    issueUpdate,
    issueDelete,
  }
}
