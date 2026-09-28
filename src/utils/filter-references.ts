/**
 * Existence checks for filter values that Linear would otherwise match against
 * nothing. An unknown team key, state name or label name in an `IssueFilter`
 * is not an error upstream; it silently yields an empty result.
 *
 * Each check is a fragment on `Query`, so it rides along with the request that
 * already reads the first page. `@include` keeps an unused check out of the
 * request, and archived objects count as existing because archived issues can
 * still carry them.
 */

import { gql } from "../__codegen__/gql.ts"
import { getGraphQLClient } from "./graphql.ts"
import { CliError, NotFoundError } from "./errors.ts"

gql(/* GraphQL */ `
  fragment TeamReferenceCheck on Query {
    referenceTeams: teams(
      filter: $teamReferenceFilter
      first: 250
      includeArchived: true
    ) @include(if: $checkTeamReferences) {
      nodes { key }
      pageInfo { hasNextPage }
    }
  }
`)

gql(/* GraphQL */ `
  fragment WorkflowStateReferenceCheck on Query {
    referenceWorkflowStates: workflowStates(
      filter: $workflowStateReferenceFilter
      first: 250
      includeArchived: true
    ) @include(if: $checkWorkflowStateReferences) {
      nodes { name }
      pageInfo { hasNextPage }
    }
  }
`)

gql(/* GraphQL */ `
  fragment IssueLabelReferenceCheck on Query {
    referenceIssueLabels: issueLabels(
      filter: $issueLabelReferenceFilter
      first: 250
      includeArchived: true
    ) @include(if: $checkIssueLabelReferences) {
      nodes { name }
      pageInfo { hasNextPage }
    }
  }
`)

gql(/* GraphQL */ `
  fragment ProjectLabelReferenceCheck on Query {
    referenceProjectLabels: projectLabels(
      filter: $projectLabelReferenceFilter
      first: 250
      includeArchived: true
    ) @include(if: $checkProjectLabelReferences) {
      nodes { name }
      pageInfo { hasNextPage }
    }
  }
`)

gql(/* GraphQL */ `
  fragment ProjectReferenceCheck on Query {
    referenceProjects: projects(
      filter: $projectReferenceFilter
      first: 250
      includeArchived: true
    ) @include(if: $checkProjectReferences) {
      nodes { id }
      pageInfo { hasNextPage }
    }
  }
`)

gql(/* GraphQL */ `
  fragment MilestoneReferenceCheck on Query {
    referenceMilestones: projectMilestones(
      filter: $milestoneReferenceFilter
      first: 250
      includeArchived: true
    ) @include(if: $checkMilestoneReferences) {
      nodes { id }
      pageInfo { hasNextPage }
    }
  }
`)

/** Used when no existing request can carry the checks. */
const checkFilterReferencesQuery = gql(/* GraphQL */ `
  query CheckFilterReferences(
    $checkTeamReferences: Boolean = false
    $teamReferenceFilter: TeamFilter
    $checkWorkflowStateReferences: Boolean = false
    $workflowStateReferenceFilter: WorkflowStateFilter
    $checkIssueLabelReferences: Boolean = false
    $issueLabelReferenceFilter: IssueLabelFilter
    $checkProjectLabelReferences: Boolean = false
    $projectLabelReferenceFilter: ProjectLabelFilter
    $checkProjectReferences: Boolean = false
    $projectReferenceFilter: ProjectFilter
    $checkMilestoneReferences: Boolean = false
    $milestoneReferenceFilter: ProjectMilestoneFilter
  ) {
    ...TeamReferenceCheck
    ...WorkflowStateReferenceCheck
    ...IssueLabelReferenceCheck
    ...ProjectLabelReferenceCheck
    ...ProjectReferenceCheck
    ...MilestoneReferenceCheck
  }
`)

type ReferenceKind =
  | "team"
  | "workflowState"
  | "issueLabel"
  | "projectLabel"
  | "project"
  | "milestone"

/** One explicit filter option whose values must name existing objects. */
export interface FilterReference {
  kind: ReferenceKind
  /** How the value was given, e.g. `--team` or `configured team_key`. */
  option: string
  values: readonly string[]
  /** Command that lists valid values; defaults per kind. */
  suggestion?: string
}

const KINDS: Record<ReferenceKind, {
  entity: string
  alias: string
  flag: string
  filterVariable: string
  field: "key" | "name" | "id"
  filter: (values: string[]) => unknown
  suggestion: string
}> = {
  team: {
    entity: "Team",
    alias: "referenceTeams",
    flag: "checkTeamReferences",
    filterVariable: "teamReferenceFilter",
    field: "key",
    filter: (keys) => ({ key: { in: keys } }),
    suggestion: "Run `linear team list` to see team keys.",
  },
  workflowState: {
    entity: "Workflow state",
    alias: "referenceWorkflowStates",
    flag: "checkWorkflowStateReferences",
    filterVariable: "workflowStateReferenceFilter",
    field: "name",
    filter: nameFilter,
    suggestion: "Run `linear team states <team-key>` to see state names.",
  },
  issueLabel: {
    entity: "Label",
    alias: "referenceIssueLabels",
    flag: "checkIssueLabelReferences",
    filterVariable: "issueLabelReferenceFilter",
    field: "name",
    filter: nameFilter,
    suggestion: "Run `linear label list --all` to see label names.",
  },
  projectLabel: {
    entity: "Project label",
    alias: "referenceProjectLabels",
    flag: "checkProjectLabelReferences",
    filterVariable: "projectLabelReferenceFilter",
    field: "name",
    filter: nameFilter,
    suggestion:
      "Run `linear api '{ projectLabels { nodes { name } } }'` to see project label names.",
  },
  project: {
    entity: "Project",
    alias: "referenceProjects",
    flag: "checkProjectReferences",
    filterVariable: "projectReferenceFilter",
    field: "id",
    filter: (ids) => ({ id: { in: ids } }),
    suggestion:
      "Pass a project UUID, slug ID (from `linear project list`), or exact project name.",
  },
  milestone: {
    entity: "Milestone",
    alias: "referenceMilestones",
    flag: "checkMilestoneReferences",
    filterVariable: "milestoneReferenceFilter",
    field: "id",
    filter: (ids) => ({ id: { in: ids } }),
    suggestion:
      "Run `linear milestone list --project <project>` to see milestone IDs.",
  },
}

/** Matches the `eqIgnoreCase` comparison the issue filter itself uses. */
function nameFilter(names: string[]): unknown {
  const clauses = names.map((name) => ({ name: { eqIgnoreCase: name } }))
  return clauses.length === 1 ? clauses[0] : { or: clauses }
}

function comparable(kind: ReferenceKind, value: string): string {
  return kind === "team" ? value.toUpperCase() : value.toLowerCase()
}

function nonEmpty(
  references: readonly FilterReference[],
): FilterReference[] {
  return references.filter((reference) => reference.values.length > 0)
}

/**
 * Variables that add the checks to a request whose operation spreads the
 * matching fragments. Returns an empty object when there is nothing to check.
 */
export function filterReferenceVariables(
  references: readonly FilterReference[],
): Record<string, unknown> {
  const variables: Record<string, unknown> = {}
  const kinds = new Set(nonEmpty(references).map((reference) => reference.kind))
  for (const kindName of kinds) {
    const kind = KINDS[kindName]
    variables[kind.flag] = true
    variables[kind.filterVariable] = kind.filter([
      ...new Set(valuesOfKind(references, kindName)),
    ])
  }
  return variables
}

function valuesOfKind(
  references: readonly FilterReference[],
  kind: ReferenceKind,
): string[] {
  return references.filter((reference) => reference.kind === kind)
    .flatMap((reference) => reference.values)
}

type CheckConnection = {
  nodes: Record<string, unknown>[]
  pageInfo: { hasNextPage: boolean }
}

function readCheck(data: unknown, alias: string): CheckConnection {
  const connection = data != null && typeof data === "object"
    ? (data as Record<string, unknown>)[alias]
    : undefined
  if (
    connection == null || typeof connection !== "object" ||
    !Array.isArray((connection as CheckConnection).nodes) ||
    typeof (connection as CheckConnection).pageInfo?.hasNextPage !== "boolean"
  ) {
    throw new CliError(`Linear returned an incomplete ${alias} check`)
  }
  return connection as CheckConnection
}

/**
 * Fail with NotFoundError when an explicit filter value names nothing.
 *
 * `data` is the response of a request sent with `filterReferenceVariables`.
 * Without it, one CheckFilterReferences request is sent. A truncated check
 * connection is re-read with only the still-missing values, so every
 * follow-up page resolves at least one value or proves it missing.
 */
export async function assertFilterReferences(
  references: readonly FilterReference[],
  data?: unknown,
): Promise<void> {
  const pending = nonEmpty(references)
  if (pending.length === 0) return
  const found = new Map<ReferenceKind, Set<string>>()
  const kinds = [...new Set(pending.map((reference) => reference.kind))]
  const missingOf = (kind: ReferenceKind) =>
    valuesOfKind(pending, kind).filter((value) =>
      !found.get(kind)?.has(comparable(kind, value))
    )

  let response = data ??
    await getGraphQLClient().request(
      checkFilterReferencesQuery,
      filterReferenceVariables(pending),
    )
  let checking = kinds
  while (true) {
    const truncated: ReferenceKind[] = []
    let progressed = false
    for (const kind of checking) {
      const { alias, field } = KINDS[kind]
      const connection = readCheck(response, alias)
      const seen = found.get(kind) ?? new Set<string>()
      for (const node of connection.nodes) {
        const value = node[field]
        if (typeof value !== "string") {
          throw new CliError(`Linear returned an incomplete ${alias} check`)
        }
        const key = comparable(kind, value)
        if (!seen.has(key)) progressed = true
        seen.add(key)
      }
      found.set(kind, seen)
      if (connection.pageInfo.hasNextPage && missingOf(kind).length > 0) {
        truncated.push(kind)
      }
    }
    if (truncated.length === 0) break
    if (!progressed) {
      throw new CliError("Linear returned a truncated filter reference check")
    }
    checking = truncated
    response = await getGraphQLClient().request(
      checkFilterReferencesQuery,
      filterReferenceVariables(
        truncated.map((kind) => ({
          kind,
          option: "",
          values: [...new Set(missingOf(kind))],
        })),
      ),
    )
  }

  for (const reference of pending) {
    const missing = reference.values.filter((value) =>
      !found.get(reference.kind)?.has(comparable(reference.kind, value))
    )
    if (missing.length === 0) continue
    const kind = KINDS[reference.kind]
    throw new NotFoundError(
      kind.entity,
      `${
        missing.map((value) => JSON.stringify(value)).join(", ")
      } (${reference.option})`,
      {
        suggestion: reference.suggestion ?? kind.suggestion,
        details: { option: reference.option, values: missing },
      },
    )
  }
}
