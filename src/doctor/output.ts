import { unicodeWidth } from "@std/cli"
import { padDisplay, truncateText } from "../utils/display.ts"
import type {
  DoctorFinding,
  DoctorProjectHealth,
  DoctorReport,
  DoctorRuleId,
} from "./types.ts"

const MAX_STRATEGY_SUMMARIES = 4

const ruleLabels: Record<DoctorRuleId, string> = {
  "project-team-mismatch": "项目与团队不一致",
  "missing-project": "缺少项目",
  "missing-priority": "缺少优先级",
  "missing-estimate": "缺少估时",
  "missing-cycle": "缺少周期",
  "stale-started": "长期未更新",
  "missing-project-update": "缺少项目更新",
  "stale-project-update": "项目更新过期",
  "project-health-risk": "项目存在风险",
}

const issueStateLabels: Record<string, string> = {
  started: "进行中",
  unstarted: "待办",
  backlog: "积压",
  triage: "待分流",
  completed: "已完成",
  canceled: "已取消",
  cancelled: "已取消",
  duplicate: "重复",
}

const projectStatusLabels: Record<string, string> = {
  started: "进行中",
  planned: "计划中",
  backlog: "积压",
  paused: "暂停",
  completed: "已完成",
  canceled: "已取消",
}

function formatIssueState(finding: DoctorFinding): string {
  if (finding.target !== "issue") return finding.project.status.name
  return issueStateLabels[finding.issue.state.type] ?? finding.issue.state.name
}

function formatProjectStatus(finding: DoctorFinding): string {
  if (finding.target !== "project") return finding.issue.state.name
  return projectStatusLabels[finding.project.status.type] ??
    finding.project.status.name
}

function formatHealth(health: DoctorProjectHealth | null): string {
  if (health == null) return "-"
  return {
    onTrack: "正常",
    atRisk: "有风险",
    offTrack: "偏离计划",
  }[health]
}

function formatScope(report: DoctorReport): string {
  const scopeNames = {
    self: "个人",
    team: "团队",
    project: "项目",
    workspace: "组织",
  } as const
  const scopeName = scopeNames[report.scope.kind]
  if (report.scope.target == null) return scopeName
  if (report.scope.kind === "self" && report.scope.target === "self") {
    return "我的任务"
  }
  return `${scopeName} / ${report.scope.target}`
}

function formatPolicy(report: DoctorReport): string {
  const history = report.policy.includeHistory ? "包含历史" : "不包含历史"
  const archived = report.policy.includeArchived ? "包含归档" : "不包含归档"
  return `${history}；${archived}；超过 ${report.policy.staleDays} 天未更新视为长期未更新；积压状态不检查周期`
}

function currentValue(finding: DoctorFinding): string {
  if (finding.target === "project") {
    switch (finding.field) {
      case "project-update":
        return finding.project.lastUpdate == null
          ? "项目更新=-"
          : `项目更新=${finding.project.lastUpdate.createdAt.slice(0, 10)}`
      case "health":
        return `健康状态=${formatHealth(finding.project.health)}`
      default:
        return "-"
    }
  }

  switch (finding.field) {
    case "project":
      if (finding.ruleId === "project-team-mismatch") {
        return `项目=${
          finding.issue.project?.name ?? "-"
        }，团队=${finding.issue.team.key}`
      }
      return "项目=-"
    case "priority":
      return "优先级=无"
    case "estimate":
      return "估时=-"
    case "cycle":
      return "周期=-"
    case "stale":
      return `更新时间=${finding.issue.updatedAt.slice(0, 10)}`
  }
  return "-"
}

function formatFindingTable(findings: DoctorFinding[]): string[] {
  const severityWidth = Math.max(
    unicodeWidth("严重度"),
    ...findings.map((f) => unicodeWidth(f.severity)),
  )
  const ruleWidth = Math.max(
    unicodeWidth("规则"),
    ...findings.map((f) => unicodeWidth(ruleLabels[f.ruleId])),
  )
  const issueWidth = Math.max(
    unicodeWidth("任务 / 项目"),
    ...findings.map((f) =>
      f.target === "issue"
        ? unicodeWidth(f.issue.identifier)
        : unicodeWidth(f.project.name)
    ),
  )
  const stateWidth = Math.max(
    unicodeWidth("状态"),
    ...findings.map((f) =>
      unicodeWidth(
        f.target === "issue" ? formatIssueState(f) : formatProjectStatus(f),
      )
    ),
  )
  const titleWidth = Math.min(
    56,
    Math.max(
      20,
      ...findings.map((f) =>
        unicodeWidth(
          f.target === "issue" ? f.issue.title : f.project.name,
        )
      ),
    ),
  )

  const lines = [
    [
      padDisplay("严重度", severityWidth),
      padDisplay("规则", ruleWidth),
      padDisplay("目标", 6),
      padDisplay("任务 / 项目", issueWidth),
      padDisplay("状态", stateWidth),
      "标题",
    ].join(" "),
  ]

  for (const finding of findings) {
    const target = finding.target === "issue" ? "任务" : "项目"
    const reference = finding.target === "issue"
      ? finding.issue.identifier
      : finding.project.name
    const state = finding.target === "issue"
      ? formatIssueState(finding)
      : formatProjectStatus(finding)
    const title = finding.target === "issue"
      ? finding.issue.title
      : finding.project.name
    lines.push([
      padDisplay(finding.severity, severityWidth),
      padDisplay(ruleLabels[finding.ruleId], ruleWidth),
      padDisplay(target, 6),
      padDisplay(reference, issueWidth),
      padDisplay(state, stateWidth),
      truncateText(title, titleWidth),
    ].join(" "))
    lines.push(
      `  当前：${currentValue(finding)}；建议：${finding.recommendation.text}`,
    )
  }

  return lines
}

function formatStrategyTable(report: DoctorReport): string[] {
  const summaries = report.strategySummaries.slice(0, MAX_STRATEGY_SUMMARIES)
  const nameWidth = Math.max(
    unicodeWidth("检查类别"),
    ...summaries.map((summary) => unicodeWidth(summary.name)),
  )
  const resourceWidth = Math.max(
    2,
    ...summaries.map((summary) => String(summary.affectedResourceCount).length),
  )
  const findingWidth = Math.max(
    3,
    ...summaries.map((summary) => String(summary.findingCount).length),
  )

  const lines = [
    `治理概览（${summaries.length} 项）`,
    [
      padDisplay("检查类别", nameWidth),
      padDisplay("资源", resourceWidth),
      padDisplay("问题", findingWidth),
      padDisplay("P0/P1/P2", 8),
      "代表性问题",
    ].join(" "),
  ]

  for (const summary of summaries) {
    const representative = summary.representativeFinding == null
      ? "-"
      : `${summary.representativeFinding.reference} ${
        truncateText(
          summary.representativeFinding.title,
          36,
        )
      }`
    lines.push([
      padDisplay(summary.name, nameWidth),
      padDisplay(String(summary.affectedResourceCount), resourceWidth),
      padDisplay(String(summary.findingCount), findingWidth),
      padDisplay(
        `${summary.bySeverity.P0}/${summary.bySeverity.P1}/${summary.bySeverity.P2}`,
        8,
      ),
      representative,
    ].join(" "))
  }

  return lines
}

export function formatDoctorReport(
  report: DoctorReport,
  limit: number,
): string[] {
  const shownFindings = limit === 0
    ? report.findings
    : report.findings.slice(0, limit)
  const lines = [
    `范围：${formatScope(report)}`,
    `检查设置：${formatPolicy(report)}`,
    `已扫描：${report.scanned.issueCount} 个任务，${report.scanned.projectCount} 个项目`,
    `治理问题：${report.summary.findingCount}（P0 ${report.summary.bySeverity.P0}，P1 ${report.summary.bySeverity.P1}，P2 ${report.summary.bySeverity.P2}）`,
    "",
    ...formatStrategyTable(report),
  ]

  if (shownFindings.length === 0) {
    lines.push("没有治理问题。")
    return lines
  }

  if (shownFindings.length < report.findings.length) {
    lines.push(`展开问题：${shownFindings.length} / ${report.findings.length}`)
  } else {
    lines.push(`展开问题：${shownFindings.length}`)
  }
  lines.push("")
  lines.push(...formatFindingTable(shownFindings))
  return lines
}
