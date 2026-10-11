/**
 * Field defaults for seeded and created records, so seeds only state what a
 * case cares about. Values follow what api.linear.app returns for a freshly
 * created object; each default is a claim about the real API that live cases
 * can check.
 */
import type { EntityRecord, Store } from "./store.ts"

type Defaults = (
  store: Store,
  record: Record<string, unknown>,
) => Record<string, unknown>

const viewer = (store: Store) => store.viewer().id

const TYPE_DEFAULTS: Record<string, Defaults> = {
  Issue: (store, record) => {
    const identifier = typeof record.identifier === "string"
      ? record.identifier
      : undefined
    const [key, number] = identifier?.split("-") ?? []
    const team = typeof record.team === "string"
      ? store.find("Team", record.team)
      : store.all("Team").find((t) => t.key === key) ?? store.all("Team")[0]
    if (team == null) throw new Error("fake: Issue seed needs a team")
    return {
      team: team.id,
      number: number == null ? undefined : Number(number),
      title: "",
      description: null,
      priority: 0,
      estimate: null,
      dueDate: null,
      sortOrder: 0,
      labels: [],
      previousIdentifiers: [],
      subscribers: [],
      creator: viewer(store),
      assignee: null,
      parent: null,
      project: null,
      projectMilestone: null,
      cycle: null,
      state: defaultState(store, team.id),
      canceledAt: null,
      completedAt: null,
      startedAt: null,
      trashed: null,
    }
  },
  Comment: (store) => ({
    user: viewer(store),
    parent: null,
    resolvedAt: null,
    resolvingUser: null,
    resolvingComment: null,
    editedAt: null,
    reactionData: [],
  }),
  Document: (store, record) => ({
    // Observed on Kadoraba: slug IDs are 12 lowercase hex characters.
    slugId: String(record.id ?? store.newId()).replace(/-/g, "").slice(-12),
    content: "",
    icon: null,
    color: null,
    creator: viewer(store),
    updatedBy: viewer(store),
    issue: null,
    project: null,
    initiative: null,
    trashed: null,
  }),
  Attachment: (store) => ({
    subtitle: null,
    sourceType: "api",
    metadata: {},
    creator: viewer(store),
  }),
  IssueLabel: () => ({
    isGroup: false,
    team: null,
    parent: null,
    description: null,
    color: "#bec2c8",
  }),
  Cycle: () => ({
    name: null,
    description: null,
    completedAt: null,
    progress: 0,
  }),
  User: (_, record) => ({
    displayName: String(record.name ?? "user").toLowerCase().replace(
      /\s+/g,
      ".",
    ),
    email: `${
      String(record.name ?? "user").toLowerCase().replace(/\s+/g, ".")
    }@example.com`,
    active: true,
    admin: false,
    guest: false,
    app: false,
  }),
}

export function defaultState(store: Store, teamId: string): string {
  const team = store.find("Team", teamId)
  if (typeof team?.defaultIssueState === "string") return team.defaultIssueState
  const states = store.all("WorkflowState")
    .filter((state) => state.team === teamId && state.type === "backlog")
    .sort((a, b) => Number(a.position) - Number(b.position))
  if (states[0] == null) throw new Error("fake: team has no backlog state")
  return states[0].id
}

/** Fill unset fields of a seed record; explicit values, including null, win. */
export function withDefaults(
  store: Store,
  typename: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const createdAt = record.createdAt ?? store.seedTimestamp()
  const filled: Record<string, unknown> = {
    createdAt,
    updatedAt: record.updatedAt ?? createdAt,
    archivedAt: null,
    ...TYPE_DEFAULTS[typename]?.(store, record),
  }
  for (const [key, value] of Object.entries(record)) {
    // Catch seed typos such as "00:75:00" before they skew ordering.
    if (
      key.endsWith("At") && typeof value === "string" &&
      (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value) ||
        Number.isNaN(Date.parse(value)))
    ) {
      throw new Error(
        `fake: ${typename}.${key} is not an ISO timestamp: ${value}`,
      )
    }
    filled[key] = value
  }
  if (typename === "Issue" && filled.identifier == null) {
    const team = store.find("Team", filled.team as string)!
    filled.number ??= nextIssueNumber(store, team.id)
    filled.identifier = `${team.key}-${filled.number}`
  }
  return Object.fromEntries(
    Object.entries(filled).filter(([, value]) => value !== undefined),
  )
}

export function nextIssueNumber(store: Store, teamId: string): number {
  return store.all("Issue")
    .filter((issue) => issue.team === teamId)
    .reduce((max, issue) => Math.max(max, Number(issue.number)), 0) + 1
}

/**
 * Expand `{"$repeat": N, ...}` into N records, replacing `{{n}}` in string
 * values with 1..N (`{{n:3}}` pads to three digits).
 */
export function expandRepeats(
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  return records.flatMap((record) => {
    const count = record.$repeat
    if (count == null) return [record]
    const { $repeat: _, ...template } = record
    return Array.from(
      { length: Number(count) },
      (_, i) => replaceN(template, i + 1) as Record<string, unknown>,
    )
  })
}

function replaceN(value: unknown, n: number): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\{\{n(?::(\d+))?\}\}/g,
      (_, width?: string) => String(n).padStart(Number(width ?? 0), "0"),
    )
  }
  if (Array.isArray(value)) return value.map((item) => replaceN(item, n))
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replaceN(v, n)]),
    )
  }
  return value
}

export type { EntityRecord }
