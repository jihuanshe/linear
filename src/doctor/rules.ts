import type {
  DoctorContext,
  DoctorFinding,
  DoctorIssue,
  DoctorIssueFinding,
  DoctorProject,
  DoctorProjectFinding,
  DoctorProjectRule,
  DoctorRule,
  DoctorRuleId,
  DoctorSeverity,
} from "./types.ts"

const TERMINAL_STATE_TYPES = new Set([
  "completed",
  "canceled",
  "cancelled",
  "duplicate",
])

function isTerminal(issue: DoctorIssue): boolean {
  return TERMINAL_STATE_TYPES.has(issue.state.type) ||
    issue.state.name.toLowerCase() === "merged"
}

function isStarted(issue: DoctorIssue): boolean {
  return issue.state.type === "started" && !isTerminal(issue)
}

function isUnstarted(issue: DoctorIssue): boolean {
  return issue.state.type === "unstarted"
}

function isTriage(issue: DoctorIssue): boolean {
  return issue.state.type === "triage"
}

function isBacklog(issue: DoctorIssue): boolean {
  return issue.state.type === "backlog"
}

function isHistoricalCheck(
  issue: DoctorIssue,
  context: DoctorContext,
): boolean {
  return context.policy.includeHistory && isTerminal(issue)
}

function severityForLifecycle(
  issue: DoctorIssue,
  historical: boolean,
): DoctorSeverity {
  if (historical || isUnstarted(issue) || isTriage(issue) || isBacklog(issue)) {
    return "P2"
  }
  return "P1"
}

function finding(
  issue: DoctorIssue,
  ruleId: DoctorRuleId,
  severity: DoctorSeverity,
  field: DoctorFinding["field"],
  evidence: string,
  recommendation: string,
): DoctorIssueFinding {
  return {
    target: "issue",
    ruleId,
    severity,
    field,
    issue,
    evidence,
    recommendation: {
      text: recommendation,
      needsHumanDecision: true,
    },
  }
}

const projectTeamMismatchRule: DoctorRule = {
  id: "project-team-mismatch",
  check(issue) {
    if (issue.project == null || issue.team == null) return null
    if (isBacklog(issue) || isTriage(issue)) return null

    if (issue.project.teams.pageInfo.hasNextPage) return null
    const projectTeams = issue.project.teams.nodes
    const matchesTeam = projectTeams.some((team) => team.key === issue.team.key)
    if (matchesTeam) return null

    return finding(
      issue,
      "project-team-mismatch",
      isTerminal(issue) ? "P2" : "P0",
      "project",
      `项目「${issue.project.name}」未包含团队 ${issue.team.key}`,
      "请确认项目归属，必要时将该任务移到合适的项目。",
    )
  },
}

const missingProjectRule: DoctorRule = {
  id: "missing-project",
  check(issue, context) {
    if (issue.project != null) return null
    if (isBacklog(issue) || isTriage(issue)) return null

    const historical = isHistoricalCheck(issue, context)
    if (!historical && !isStarted(issue) && !isUnstarted(issue)) return null

    return finding(
      issue,
      "missing-project",
      severityForLifecycle(issue, historical),
      "project",
      "任务没有项目",
      "请为该任务指定项目。",
    )
  },
}

const missingPriorityRule: DoctorRule = {
  id: "missing-priority",
  check(issue, context) {
    if (issue.priority !== 0) return null
    if (isBacklog(issue) || isTriage(issue)) return null
    if (!context.policy.includeHistory && isTerminal(issue)) return null

    return finding(
      issue,
      "missing-priority",
      severityForLifecycle(issue, isHistoricalCheck(issue, context)),
      "priority",
      "任务没有优先级",
      "请为该任务指定优先级。",
    )
  },
}

const missingEstimateRule: DoctorRule = {
  id: "missing-estimate",
  check(issue, context) {
    if (issue.estimate != null) return null
    if (issue.team.issueEstimationType === "notUsed") return null

    const historical = isHistoricalCheck(issue, context)
    if (!historical && !isStarted(issue) && !isUnstarted(issue)) return null

    return finding(
      issue,
      "missing-estimate",
      severityForLifecycle(issue, historical),
      "estimate",
      "任务没有估时",
      "请填写该任务的估时。",
    )
  },
}

const missingCycleRule: DoctorRule = {
  id: "missing-cycle",
  check(issue, context) {
    if (issue.cycle != null || issue.team.cyclesEnabled !== true) return null
    if (issue.team.activeCycle == null) return null
    if (isBacklog(issue) || isTriage(issue)) return null

    const historical = isHistoricalCheck(issue, context)
    if (!historical && !isStarted(issue) && !isUnstarted(issue)) return null

    return finding(
      issue,
      "missing-cycle",
      severityForLifecycle(issue, historical),
      "cycle",
      `任务没有周期；团队 ${issue.team.key} 已启用周期`,
      "请确认是否将该任务加入当前周期；暂不排期时可以留空。",
    )
  },
}

const staleStartedRule: DoctorRule = {
  id: "stale-started",
  check(issue, context) {
    if (!isStarted(issue)) return null

    const updatedAt = new Date(issue.updatedAt).getTime()
    const staleAt = context.now.getTime() -
      context.policy.staleDays * 86_400_000
    if (updatedAt >= staleAt) return null

    return finding(
      issue,
      "stale-started",
      "P1",
      "stale",
      `进行中任务已至少 ${context.policy.staleDays} 天未更新`,
      "请确认该任务是否仍在推进；如已阻塞、拆分或完成，请更新状态和下一步。",
    )
  },
}

const ACTIVE_PROJECT_STATUS_TYPES = new Set(["started", "planned"])
const TERMINAL_PROJECT_STATUS_TYPES = new Set(["completed", "canceled"])

function isActiveProject(project: DoctorProject): boolean {
  return ACTIVE_PROJECT_STATUS_TYPES.has(project.status.type)
}

function isHistoricalProject(
  project: DoctorProject,
  context: DoctorContext,
): boolean {
  return context.policy.includeHistory &&
    TERMINAL_PROJECT_STATUS_TYPES.has(project.status.type)
}

function shouldCheckProject(
  project: DoctorProject,
  context: DoctorContext,
): boolean {
  return isActiveProject(project) || isHistoricalProject(project, context)
}

function projectSeverity(
  project: DoctorProject,
  historical: boolean,
): DoctorSeverity {
  return historical || project.status.type === "planned" ? "P2" : "P1"
}

function projectAgeInDays(project: DoctorProject, now: Date): number {
  const createdAt = new Date(project.startedAt ?? project.createdAt).getTime()
  return (now.getTime() - createdAt) / 86_400_000
}

function projectUpdateAgeInDays(project: DoctorProject, now: Date): number {
  const createdAt = new Date(project.lastUpdate!.createdAt).getTime()
  return (now.getTime() - createdAt) / 86_400_000
}

function projectFinding(
  project: DoctorProject,
  ruleId: DoctorRuleId,
  severity: DoctorSeverity,
  field: DoctorProjectFinding["field"],
  evidence: string,
  recommendation: string,
): DoctorProjectFinding {
  return {
    target: "project",
    ruleId,
    severity,
    field,
    project,
    evidence,
    recommendation: {
      text: recommendation,
      needsHumanDecision: true,
    },
  }
}

const missingProjectUpdateRule: DoctorProjectRule = {
  id: "missing-project-update",
  check(project, context) {
    if (!shouldCheckProject(project, context)) return null
    if (project.lastUpdate != null) return null
    if (projectAgeInDays(project, context.now) < context.policy.staleDays) {
      return null
    }

    const historical = isHistoricalProject(project, context)
    return projectFinding(
      project,
      "missing-project-update",
      projectSeverity(project, historical),
      "project-update",
      `项目已超过 ${context.policy.staleDays} 天没有项目更新`,
      "请发布项目更新，或更新项目状态。",
    )
  },
}

const staleProjectUpdateRule: DoctorProjectRule = {
  id: "stale-project-update",
  check(project, context) {
    if (!shouldCheckProject(project, context)) return null
    if (project.lastUpdate == null) return null
    const ageInDays = projectUpdateAgeInDays(project, context.now)
    if (ageInDays < context.policy.staleDays) {
      return null
    }

    const historical = isHistoricalProject(project, context)
    const age = Math.floor(ageInDays)
    return projectFinding(
      project,
      "stale-project-update",
      projectSeverity(project, historical),
      "project-update",
      `最近一次项目更新已是 ${age} 天前${
        project.lastUpdate.isStale ? "，并被 Linear 标记为过期" : ""
      }`,
      "请发布新的项目更新，或更新项目状态。",
    )
  },
}

const projectHealthRiskRule: DoctorProjectRule = {
  id: "project-health-risk",
  check(project, context) {
    if (!shouldCheckProject(project, context)) return null
    if (project.health !== "atRisk" && project.health !== "offTrack") {
      return null
    }

    const historical = isHistoricalProject(project, context)
    const health = project.health === "atRisk" ? "有风险" : "偏离计划"
    return projectFinding(
      project,
      "project-health-risk",
      projectSeverity(project, historical),
      "health",
      `项目健康状态为「${health}」`,
      "请确认风险原因和下一步，并发布项目更新。",
    )
  },
}

export const doctorRules: DoctorRule[] = [
  projectTeamMismatchRule,
  missingProjectRule,
  missingPriorityRule,
  missingEstimateRule,
  missingCycleRule,
  staleStartedRule,
]

export const doctorProjectRules: DoctorProjectRule[] = [
  missingProjectUpdateRule,
  staleProjectUpdateRule,
  projectHealthRiskRule,
]

export const doctorRuleIds = [
  ...doctorRules,
  ...doctorProjectRules,
].map((rule) => rule.id)
