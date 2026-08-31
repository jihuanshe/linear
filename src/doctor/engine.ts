import { doctorProjectRules, doctorRules } from "./rules.ts"
import { doctorStrategies } from "./strategies.ts"
import type {
  DoctorContext,
  DoctorFinding,
  DoctorIssue,
  DoctorPolicy,
  DoctorProject,
  DoctorReport,
  DoctorScope,
  DoctorSeverity,
  DoctorStrategySummary,
} from "./types.ts"

const severityOrder: Record<DoctorSeverity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
}

const stateOrder: Record<string, number> = {
  started: 0,
  unstarted: 1,
  triage: 2,
  backlog: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
}

const projectStatusOrder: Record<string, number> = {
  started: 0,
  planned: 1,
  backlog: 2,
  paused: 3,
  completed: 4,
  canceled: 5,
}

function isTerminal(issue: DoctorIssue): boolean {
  return ["completed", "canceled", "cancelled", "duplicate"].includes(
    issue.state.type,
  ) || issue.state.name.toLowerCase() === "merged"
}

function compareFindings(
  a: DoctorFinding,
  b: DoctorFinding,
): number {
  const severityComparison = severityOrder[a.severity] -
    severityOrder[b.severity]
  if (severityComparison !== 0) return severityComparison

  const lifecycleA = a.target === "issue"
    ? stateOrder[a.issue.state.type] ?? 99
    : projectStatusOrder[a.project.status.type] ?? 99
  const lifecycleB = b.target === "issue"
    ? stateOrder[b.issue.state.type] ?? 99
    : projectStatusOrder[b.project.status.type] ?? 99
  const stateComparison = lifecycleA - lifecycleB
  if (stateComparison !== 0) return stateComparison

  const ruleComparison = a.ruleId.localeCompare(b.ruleId)
  if (ruleComparison !== 0) return ruleComparison

  const identifierA = a.target === "issue" ? a.issue.identifier : a.project.name
  const identifierB = b.target === "issue" ? b.issue.identifier : b.project.name
  return identifierA.localeCompare(identifierB)
}

function emptySeverityCounts(): Record<DoctorSeverity, number> {
  return { P0: 0, P1: 0, P2: 0 }
}

function countBySeverity(
  findings: DoctorFinding[],
): Record<DoctorSeverity, number> {
  const bySeverity = emptySeverityCounts()
  for (const finding of findings) {
    bySeverity[finding.severity]++
  }
  return bySeverity
}

function findingResourceId(finding: DoctorFinding): string {
  return finding.target === "issue" ? finding.issue.id : finding.project.id
}

function findingReference(finding: DoctorFinding): string {
  return finding.target === "issue"
    ? finding.issue.identifier
    : finding.project.name
}

function findingTitle(finding: DoctorFinding): string {
  return finding.target === "issue" ? finding.issue.title : finding.project.name
}

function summarizeRepresentative(
  finding: DoctorFinding | undefined,
): DoctorStrategySummary["representativeFinding"] {
  if (finding == null) return null
  return {
    target: finding.target,
    id: findingResourceId(finding),
    reference: findingReference(finding),
    title: findingTitle(finding),
    ruleId: finding.ruleId,
    severity: finding.severity,
    field: finding.field,
    evidence: finding.evidence,
  }
}

function summarizeStrategies(
  findings: DoctorFinding[],
  selectedRules: Set<DoctorFinding["ruleId"]>,
): DoctorStrategySummary[] {
  return doctorStrategies.map((strategy) => {
    const strategyFindings = findings.filter((finding) =>
      strategy.ruleIds.includes(finding.ruleId)
    )
    const affectedResources = new Set(
      strategyFindings.map(findingResourceId),
    )
    const rules = strategy.ruleIds.filter((ruleId) => selectedRules.has(ruleId))
      .map((ruleId) => {
        const ruleFindings = strategyFindings.filter((finding) =>
          finding.ruleId === ruleId
        )
        return {
          ruleId,
          findingCount: ruleFindings.length,
          affectedResourceCount: new Set(ruleFindings.map(findingResourceId))
            .size,
          bySeverity: countBySeverity(ruleFindings),
        }
      })

    return {
      id: strategy.id,
      name: strategy.name,
      purpose: strategy.purpose,
      lifecycle: strategy.lifecycle,
      defaultThreshold: strategy.defaultThreshold,
      findingCount: strategyFindings.length,
      affectedResourceCount: affectedResources.size,
      bySeverity: countBySeverity(strategyFindings),
      rules,
      representativeFinding: summarizeRepresentative(strategyFindings[0]),
    }
  })
}

export function evaluateDoctorIssues(
  issues: DoctorIssue[],
  scope: DoctorScope,
  policy: DoctorPolicy,
  now: Date,
  projects: DoctorProject[] = [],
): DoctorReport {
  const scopedIssues = policy.includeHistory
    ? issues
    : issues.filter((issue) => !isTerminal(issue))
  const selectedRules = new Set(policy.selectedRules)
  const issueRules = doctorRules.filter((rule) => selectedRules.has(rule.id))
  const projectRules = doctorProjectRules.filter((rule) =>
    selectedRules.has(rule.id)
  )
  const context: DoctorContext = { now, policy }

  const findings = scopedIssues.flatMap((issue) =>
    issueRules.flatMap((rule) => {
      const result = rule.check(issue, context)
      return result == null ? [] : [result]
    })
  ).concat(
    projects.flatMap((project) =>
      projectRules.flatMap((rule) => {
        const result = rule.check(project, context)
        return result == null ? [] : [result]
      })
    ),
  ).sort(compareFindings)

  const bySeverity = countBySeverity(findings)

  return {
    schemaVersion: 1,
    scope,
    policy,
    scanned: {
      issueCount: scopedIssues.length,
      projectCount: projects.length,
    },
    summary: {
      findingCount: findings.length,
      bySeverity,
    },
    strategySummaries: summarizeStrategies(findings, selectedRules),
    findings,
  }
}
