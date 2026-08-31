import type { FetchedQueryIssueResult } from "../utils/linear.ts"

export type DoctorIssue = FetchedQueryIssueResult

export type DoctorProjectHealth = "onTrack" | "atRisk" | "offTrack"

export interface DoctorProject {
  id: string
  name: string
  createdAt: string
  startedAt: string | null
  status: {
    name: string
    type: string
  }
  health: DoctorProjectHealth | null
  healthUpdatedAt: string | null
  lastUpdate: {
    createdAt: string
    updatedAt: string
    health: DoctorProjectHealth
    isStale: boolean
  } | null
}

export type DoctorScopeKind = "self" | "team" | "project" | "workspace"

export interface DoctorScope {
  kind: DoctorScopeKind
  target?: string
}

export type DoctorSeverity = "P0" | "P1" | "P2"

export type DoctorRuleId =
  | "project-team-mismatch"
  | "missing-project"
  | "missing-priority"
  | "missing-estimate"
  | "missing-cycle"
  | "stale-started"
  | "missing-project-update"
  | "stale-project-update"
  | "project-health-risk"

export type DoctorStrategyId =
  | "execution-readiness"
  | "project-pulse"
  | "ownership-and-classification"
  | "flow-progress"

export type DoctorField =
  | "project"
  | "priority"
  | "estimate"
  | "cycle"
  | "stale"
  | "project-update"
  | "health"

export interface DoctorPolicy {
  includeHistory: boolean
  includeArchived: boolean
  staleDays: number
  backlogCycleRequired: false
  selectedRules: DoctorRuleId[]
}

export interface DoctorContext {
  now: Date
  policy: DoctorPolicy
}

interface DoctorFindingBase {
  ruleId: DoctorRuleId
  severity: DoctorSeverity
  field: DoctorField
  evidence: string
  recommendation: {
    text: string
    needsHumanDecision: true
  }
}

export interface DoctorIssueFinding extends DoctorFindingBase {
  target: "issue"
  issue: DoctorIssue
}

export interface DoctorProjectFinding extends DoctorFindingBase {
  target: "project"
  project: DoctorProject
}

export type DoctorFinding = DoctorIssueFinding | DoctorProjectFinding

export interface DoctorRule {
  id: DoctorRuleId
  check: (issue: DoctorIssue, context: DoctorContext) => DoctorFinding | null
}

export interface DoctorProjectRule {
  id: DoctorRuleId
  check: (
    project: DoctorProject,
    context: DoctorContext,
  ) => DoctorProjectFinding | null
}

export interface DoctorStrategyDefinition {
  id: DoctorStrategyId
  name: string
  purpose: string
  ruleIds: DoctorRuleId[]
  lifecycle: string
  defaultThreshold: string
}

export interface DoctorRuleSummary {
  ruleId: DoctorRuleId
  findingCount: number
  affectedResourceCount: number
  bySeverity: Record<DoctorSeverity, number>
}

export interface DoctorRepresentativeFinding {
  target: DoctorFinding["target"]
  id: string
  reference: string
  title: string
  ruleId: DoctorRuleId
  severity: DoctorSeverity
  field: DoctorField
  evidence: string
}

export interface DoctorStrategySummary {
  id: DoctorStrategyId
  name: string
  purpose: string
  lifecycle: string
  defaultThreshold: string
  findingCount: number
  affectedResourceCount: number
  bySeverity: Record<DoctorSeverity, number>
  rules: DoctorRuleSummary[]
  representativeFinding: DoctorRepresentativeFinding | null
}

export interface DoctorReport {
  schemaVersion: 1
  scope: DoctorScope
  policy: DoctorPolicy
  scanned: {
    issueCount: number
    projectCount: number
  }
  summary: {
    findingCount: number
    bySeverity: Record<DoctorSeverity, number>
  }
  strategySummaries: DoctorStrategySummary[]
  findings: DoctorFinding[]
}
