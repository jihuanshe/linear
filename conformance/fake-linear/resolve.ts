/**
 * Schema-driven read semantics.
 *
 * Every field resolves from stored records: scalars by name, entity fields by
 * stored ID, and connections by explicit ID lists or the reference that points
 * back at the parent. Rules that differ from that pattern are listed in
 * COMPUTED and RELATIONS so each deviation from "just read the record" is
 * visible and can be checked against the real API.
 */
import {
  getNamedType,
  type GraphQLField,
  type GraphQLFieldResolver,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLOutputType,
  type GraphQLSchema,
  isAbstractType,
  isListType,
  isNonNullType,
  isObjectType,
} from "graphql"
import type { EntityRecord, Store } from "./store.ts"
import { LinearError } from "./errors.ts"

export interface Context {
  store: Store
  schema: GraphQLSchema
}

type Computed = (record: EntityRecord, ctx: Context) => unknown

const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"]

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-")
}

const COMPUTED: Record<string, Computed> = {
  "Issue.priorityLabel": (issue) =>
    PRIORITY_LABELS[Number(issue.priority ?? 0)],
  "Issue.url": (issue, { store }) =>
    `https://linear.app/${
      store.singleton("Organization").urlKey
    }/issue/${issue.identifier}/${slugify(String(issue.title))}`,
  "Issue.branchName": (issue, { store }) => {
    const viewer = store.viewer()
    return `${viewer.displayName}/${String(issue.identifier).toLowerCase()}-${
      slugify(String(issue.title))
    }`
  },
  // Observed on Kadoraba: the issue URL plus the comment ID's first 8 characters.
  "Comment.url": (comment, ctx) => {
    const issue = ctx.store.find("Issue", comment.issue as string)
    return issue == null
      ? null
      : `${COMPUTED["Issue.url"](issue, ctx)}#comment-${comment.id.slice(0, 8)}`
  },
  // Observed on Kadoraba: /document/<title slug>-<slugId>.
  "Document.url": (document, { store }) =>
    `https://linear.app/${store.singleton("Organization").urlKey}/document/${
      slugify(String(document.title))
    }-${document.slugId}`,
  "User.isMe": (user, { store }) => user.id === store.viewer().id,
  // Cycle state follows from its dates relative to the world's current time.
  "Cycle.isActive": (cycle, { store }) =>
    cyclePhase(cycle, store.worldNow()) === "active",
  "Cycle.isFuture": (cycle, { store }) =>
    cyclePhase(cycle, store.worldNow()) === "future",
  "Cycle.isPast": (cycle, { store }) =>
    cyclePhase(cycle, store.worldNow()) === "past",
  "Cycle.isNext": (cycle, { store }) =>
    teamCycles(store, cycle.team as string)
      .find((c) => cyclePhase(c, store.worldNow()) === "future")?.id ===
      cycle.id,
  "Cycle.isPrevious": (cycle, { store }) =>
    teamCycles(store, cycle.team as string)
      .findLast((c) => cyclePhase(c, store.worldNow()) === "past")?.id ===
      cycle.id,
  "Team.activeCycle": (team, { store }) =>
    teamCycles(store, team.id)
      .find((c) => cyclePhase(c, store.worldNow()) === "active")?.id ?? null,
  "Team.organization": (_, { store }) => store.singleton("Organization").id,
}

function cyclePhase(
  cycle: EntityRecord,
  now: string,
): "past" | "active" | "future" {
  if (String(cycle.startsAt) > now) return "future"
  if (String(cycle.endsAt) <= now) return "past"
  return "active"
}

function teamCycles(store: Context["store"], teamId: string): EntityRecord[] {
  return store.all("Cycle").filter((c) => c.team === teamId)
    .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))
}

/**
 * Connection fields whose elements cannot be inferred from a single
 * back-reference: [node type, field on the node that holds the parent ID].
 */
const RELATIONS: Record<string, [string, string]> = {
  "Issue.children": ["Issue", "parent"],
  "Issue.history": ["IssueHistory", "issue"],
  "Issue.comments": ["Comment", "issue"],
  "Issue.attachments": ["Attachment", "issue"],
  "Issue.relations": ["IssueRelation", "issue"],
  "Issue.inverseRelations": ["IssueRelation", "relatedIssue"],
  "Comment.children": ["Comment", "parent"],
  "Team.issues": ["Issue", "team"],
  "Team.states": ["WorkflowState", "team"],
  "Team.labels": ["IssueLabel", "team"],
  "User.assignedIssues": ["Issue", "assignee"],
  "User.createdIssues": ["Issue", "creator"],
  "Project.issues": ["Issue", "project"],
  "ProjectMilestone.issues": ["Issue", "projectMilestone"],
  "Cycle.issues": ["Issue", "cycle"],
  "IssueLabel.children": ["IssueLabel", "parent"],
}

/** Root fields that look up one entity, with natural keys accepted as IDs. */
const ROOT_LOOKUPS: Record<string, string[]> = {
  issue: ["identifier"],
  team: ["key"],
  project: ["slugId"],
  document: ["slugId"],
  initiative: ["slugId"],
}

export function concreteTypes(ctx: Context, typename: string): string[] {
  const type = ctx.schema.getType(typename)
  if (type != null && isAbstractType(type)) {
    return ctx.schema.getPossibleTypes(type).map((t) => t.name)
  }
  return [typename]
}

function isConnection(type: GraphQLOutputType): boolean {
  const named = getNamedType(type)
  return isObjectType(named) && named.name.endsWith("Connection") &&
    "nodes" in named.getFields()
}

function connectionNodeType(type: GraphQLOutputType): string {
  const named = getNamedType(type)
  if (!isObjectType(named)) throw new Error("not a connection")
  return getNamedType(named.getFields().nodes.type).name
}

function isEntity(record: unknown): record is EntityRecord {
  return typeof record === "object" && record != null &&
    "__typename" in record && "id" in record
}

export function lookup(
  ctx: Context,
  typename: string,
  id: string,
  naturalKeys: string[] = [],
): EntityRecord {
  const types = concreteTypes(ctx, typename)
  const byId = ctx.store.findAny(types, id)
  if (byId != null) return byId
  for (const key of naturalKeys) {
    for (const type of types) {
      const match = ctx.store.all(type).find((record) =>
        typeof record[key] === "string" &&
        (record[key] as string).toLowerCase() === id.toLowerCase()
      )
      if (match != null) return match
    }
  }
  throw LinearError.notFound(typename)
}

function resolveRef(ctx: Context, typename: string, value: unknown): unknown {
  if (value == null) return null
  if (typeof value !== "string") return value
  return ctx.store.findAny(concreteTypes(ctx, typename), value) ?? null
}

function connectionElements(
  ctx: Context,
  parent: EntityRecord | null,
  parentType: string,
  field: GraphQLField<unknown, unknown>,
): EntityRecord[] {
  const nodeType = connectionNodeType(field.type)
  const nodeTypes = concreteTypes(ctx, nodeType)
  if (parent == null) {
    return nodeTypes.flatMap((type) => ctx.store.all(type))
  }
  const stored = parent[field.name]
  if (Array.isArray(stored)) {
    return stored.flatMap((id) => {
      const record = ctx.store.findAny(nodeTypes, String(id))
      return record == null ? [] : [record]
    })
  }
  const explicit = RELATIONS[`${parentType}.${field.name}`]
  if (explicit != null) {
    const [type, key] = explicit
    return ctx.store.all(type).filter((record) => record[key] === parent.id)
  }
  const nodeObject = ctx.schema.getType(nodeType)
  if (!isObjectType(nodeObject)) {
    throw new Error(`fake: cannot infer ${parentType}.${field.name}`)
  }
  const backRefs = Object.values(nodeObject.getFields()).filter((f) =>
    !isListType(f.type) &&
    !(isNonNullType(f.type) && isListType(f.type.ofType)) &&
    concreteTypes(ctx, getNamedType(f.type).name).includes(parentType)
  )
  if (backRefs.length !== 1) {
    throw new Error(
      `fake: ${parentType}.${field.name} needs an entry in RELATIONS (${backRefs.length} candidate back-references)`,
    )
  }
  const key = backRefs[0].name
  return nodeTypes.flatMap((type) =>
    ctx.store.all(type).filter((record) => record[key] === parent.id)
  )
}

// ---------------------------------------------------------------------------
// Filters

const COMPARATORS = new Set([
  "eq",
  "neq",
  "in",
  "nin",
  "lt",
  "lte",
  "gt",
  "gte",
  "null",
  "contains",
  "notContains",
  "containsIgnoreCase",
  "notContainsIgnoreCase",
  "startsWith",
  "startsWithIgnoreCase",
  "notStartsWith",
  "endsWith",
  "notEndsWith",
  "eqIgnoreCase",
  "neqIgnoreCase",
])

function compare(op: string, actual: unknown, expected: unknown): boolean {
  const lower = (v: unknown) => String(v ?? "").toLowerCase()
  switch (op) {
    case "eq":
      return actual === expected
    case "neq":
      return actual !== expected
    case "in":
      return (expected as unknown[]).includes(actual)
    case "nin":
      return !(expected as unknown[]).includes(actual)
    case "lt":
      return actual != null && (actual as number) < (expected as number)
    case "lte":
      return actual != null && (actual as number) <= (expected as number)
    case "gt":
      return actual != null && (actual as number) > (expected as number)
    case "gte":
      return actual != null && (actual as number) >= (expected as number)
    case "null":
      return (actual == null) === expected
    case "contains":
      return String(actual ?? "").includes(String(expected))
    case "notContains":
      return !String(actual ?? "").includes(String(expected))
    case "containsIgnoreCase":
      return lower(actual).includes(lower(expected))
    case "notContainsIgnoreCase":
      return !lower(actual).includes(lower(expected))
    case "startsWith":
      return String(actual ?? "").startsWith(String(expected))
    case "startsWithIgnoreCase":
      return lower(actual).startsWith(lower(expected))
    case "notStartsWith":
      return !String(actual ?? "").startsWith(String(expected))
    case "endsWith":
      return String(actual ?? "").endsWith(String(expected))
    case "notEndsWith":
      return !String(actual ?? "").endsWith(String(expected))
    case "eqIgnoreCase":
      return lower(actual) === lower(expected)
    case "neqIgnoreCase":
      return lower(actual) !== lower(expected)
  }
  throw new Error(`fake: unsupported comparator ${op}`)
}

/** Filter keys that name a relation differently from the object field. */
const FILTER_ALIASES: Record<string, string> = {
  "Project.accessibleTeams": "teams",
}

function fieldValue(
  ctx: Context,
  record: EntityRecord,
  filterKey: string,
): unknown {
  const name = FILTER_ALIASES[`${record.__typename}.${filterKey}`] ?? filterKey
  const type = ctx.schema.getType(record.__typename)
  if (!isObjectType(type)) return record[name]
  const field = type.getFields()[name]
  if (field == null) {
    throw new Error(`fake: filter field ${record.__typename}.${name}`)
  }
  const computed = COMPUTED[`${record.__typename}.${name}`]
  if (computed != null) return computed(record, ctx)
  if (isConnection(field.type)) {
    return connectionElements(ctx, record, record.__typename, field)
  }
  const named = getNamedType(field.type)
  if (isObjectType(named) || isAbstractType(named)) {
    const value = record[name]
    if (Array.isArray(value)) {
      return value.map((id) => resolveRef(ctx, named.name, id))
    }
    return resolveRef(ctx, named.name, value)
  }
  return record[name]
}

export function matchesFilter(
  ctx: Context,
  record: EntityRecord,
  filter: Record<string, unknown> | null | undefined,
): boolean {
  if (filter == null) return true
  for (const [key, condition] of Object.entries(filter)) {
    if (condition == null) continue
    if (key === "and") {
      if (
        !(condition as Record<string, unknown>[]).every((f) =>
          matchesFilter(ctx, record, f)
        )
      ) return false
      continue
    }
    if (key === "or") {
      if (
        !(condition as Record<string, unknown>[]).some((f) =>
          matchesFilter(ctx, record, f)
        )
      ) return false
      continue
    }
    if (key === "isMe") {
      const want = (condition as { eq?: boolean }).eq
      if ((record.id === ctx.store.viewer().id) !== want) return false
      continue
    }
    const value = fieldValue(ctx, record, key)
    if (!matchesCondition(ctx, value, condition as Record<string, unknown>)) {
      return false
    }
  }
  return true
}

function matchesCondition(
  ctx: Context,
  value: unknown,
  condition: Record<string, unknown>,
): boolean {
  const nested: Record<string, unknown> = {}
  for (const [op, expected] of Object.entries(condition)) {
    if (expected === undefined) continue
    if (COMPARATORS.has(op)) {
      const actual = isEntity(value) ? value.id : value
      if (!compare(op, actual, expected)) return false
    } else if (op === "some" || op === "every" || op === "none") {
      const items = (value as EntityRecord[] | null) ?? []
      const test = (item: EntityRecord) =>
        matchesFilter(ctx, item, expected as Record<string, unknown>)
      if (op === "some" && !items.some(test)) return false
      if (op === "every" && !items.every(test)) return false
      if (op === "none" && items.some(test)) return false
    } else {
      nested[op] = expected
    }
  }
  if (Object.keys(nested).length === 0) return true
  if (!isEntity(value)) return false
  return matchesFilter(ctx, value, nested)
}

// ---------------------------------------------------------------------------
// Connections

interface ConnectionArgs {
  filter?: Record<string, unknown> | null
  first?: number | null
  after?: string | null
  last?: number | null
  before?: string | null
  includeArchived?: boolean | null
  orderBy?: string | null
}

function buildConnection(
  ctx: Context,
  elements: EntityRecord[],
  args: ConnectionArgs,
) {
  let items = elements.filter((record) =>
    args.includeArchived === true || record.archivedAt == null
  )
  items = items.filter((record) => matchesFilter(ctx, record, args.filter))
  const key = args.orderBy === "updatedAt" ? "updatedAt" : "createdAt"
  items.sort((a, b) =>
    String(b[key] ?? "").localeCompare(String(a[key] ?? "")) ||
    a.id.localeCompare(b.id)
  )
  if (args.after != null) {
    const index = items.findIndex((record) => record.id === args.after)
    if (index < 0) throw LinearError.input("Invalid cursor")
    items = items.slice(index + 1)
  }
  if (args.before != null) {
    const index = items.findIndex((record) => record.id === args.before)
    if (index < 0) throw LinearError.input("Invalid cursor")
    items = items.slice(0, index)
  }
  const first = args.first ?? (args.last == null ? 50 : undefined)
  let hasNextPage = false
  let hasPreviousPage = false
  if (first != null && items.length > first) {
    items = items.slice(0, first)
    hasNextPage = true
  }
  if (args.last != null && items.length > args.last) {
    items = items.slice(items.length - args.last)
    hasPreviousPage = true
  }
  return {
    nodes: items,
    edges: items.map((node) => ({ node, cursor: node.id })),
    pageInfo: {
      hasNextPage,
      hasPreviousPage,
      startCursor: items[0]?.id ?? null,
      endCursor: items.at(-1)?.id ?? null,
    },
  }
}

// ---------------------------------------------------------------------------
// Field resolver

function missingRequired(
  parentType: string,
  field: string,
  type: GraphQLOutputType,
): boolean {
  return type instanceof GraphQLNonNull &&
    !(type.ofType instanceof GraphQLList) &&
    !parentType.endsWith("Payload") && parentType !== "PageInfo" &&
    !field.startsWith("__")
}

export const fieldResolver: GraphQLFieldResolver<unknown, Context> = (
  source,
  args,
  ctx,
  info,
) => {
  const parentType = info.parentType.name
  const name = info.fieldName
  const field = info.parentType.getFields()[name]

  if (parentType === "Query" || parentType === "Mutation") {
    const override = (source as Record<string, unknown> | undefined)?.[name]
    if (typeof override === "function") return override(args, ctx, info)
    if (isConnection(field.type)) {
      return buildConnection(
        ctx,
        connectionElements(ctx, null, parentType, field),
        args as ConnectionArgs,
      )
    }
    const named = getNamedType(field.type)
    if ("id" in args && typeof args.id === "string") {
      return lookup(ctx, named.name, args.id, ROOT_LOOKUPS[name] ?? [])
    }
    throw new Error(`fake: root field ${parentType}.${name} is not implemented`)
  }

  if (source == null || typeof source !== "object") return null
  const record = source as Record<string, unknown>

  if (isEntity(record)) {
    const computed = COMPUTED[`${record.__typename}.${name}`]
    if (computed != null) {
      const value = computed(record, ctx)
      return isObjectType(getNamedType(field.type)) && typeof value === "string"
        ? resolveRef(ctx, getNamedType(field.type).name, value)
        : value
    }
    if (isConnection(field.type)) {
      return buildConnection(
        ctx,
        connectionElements(ctx, record, record.__typename, field),
        args as ConnectionArgs,
      )
    }
  }

  const value = record[name]
  const named = getNamedType(field.type)
  if (isObjectType(named) || isAbstractType(named)) {
    if (Array.isArray(value)) {
      return value.map((item) => resolveRef(ctx, named.name, item))
    }
    return resolveRef(ctx, named.name, value)
  }
  // `fooId` scalars mirror the stored reference `foo`.
  if (
    value === undefined && isEntity(record) && name.endsWith("Id") &&
    typeof record[name.slice(0, -2)] === "string"
  ) {
    return record[name.slice(0, -2)]
  }
  if (value === undefined && isEntity(record)) {
    if (missingRequired(record.__typename, name, field.type)) {
      throw new Error(
        `fake: ${record.__typename}.${name} is non-null but the record has no value; add it to the seed or the fake's defaults`,
      )
    }
    return null
  }
  return value
}

export const typeResolver = (value: unknown) =>
  isEntity(value) ? value.__typename : undefined
