#!/usr/bin/env -S deno run --allow-run --allow-env --allow-read
// Organization policy lives here. Edit these conditions for your workspace.
// All network access and complete pagination belong to the installed CLI.
import { parseArgs } from "@std/cli/parse-args"

export const doctorRuleIds = [
  "project-team-mismatch",
  "missing-project",
  "missing-priority",
  "missing-estimate",
  "missing-cycle",
  "stale-started",
  "missing-project-update",
  "stale-project-update",
  "project-health-risk",
]
const terminal = (issue) =>
  ["completed", "canceled", "cancelled", "duplicate"].includes(
    issue.state.type,
  ) ||
  issue.state.name.toLowerCase() === "merged"

export function evaluateDoctorIssues(
  issues,
  scope,
  policy,
  now,
  projects = [],
) {
  const findings = []
  const selected = new Set(policy.selectedRules)
  const scoped = policy.includeHistory
    ? issues
    : issues.filter((i) => !terminal(i))
  const add = (object, target, ruleId, severity, field, evidence, text) => {
    if (selected.has(ruleId)) {
      findings.push({
        target,
        [target]: object,
        ruleId,
        severity,
        field,
        evidence,
        recommendation: { text, needsHumanDecision: true },
      })
    }
  }
  const threshold = policy.staleDays * 86_400_000
  for (const issue of scoped) {
    const historical = policy.includeHistory && terminal(issue)
    const started = issue.state.type === "started" && !terminal(issue)
    const unstarted = issue.state.type === "unstarted"
    const deferred = ["backlog", "triage"].includes(issue.state.type)
    const severity = historical || unstarted || deferred ? "P2" : "P1"
    const active = started || unstarted || historical
    if (
      !deferred && issue.project?.teams &&
      !issue.project.teams.pageInfo.hasNextPage &&
      !issue.project.teams.nodes.some((t) => t.key === issue.team.key)
    ) {
      add(
        issue,
        "issue",
        "project-team-mismatch",
        terminal(issue) ? "P2" : "P0",
        "project",
        `项目「${issue.project.name}」未包含团队 ${issue.team.key}`,
        "请确认项目归属，必要时将该任务移到合适的项目。",
      )
    }
    if (!deferred && active && issue.project == null) {
      add(
        issue,
        "issue",
        "missing-project",
        severity,
        "project",
        "任务没有项目",
        "请为该任务指定项目。",
      )
    }
    if (
      !deferred && issue.priority === 0 &&
      (policy.includeHistory || !terminal(issue))
    ) {
      add(
        issue,
        "issue",
        "missing-priority",
        severity,
        "priority",
        "任务没有优先级",
        "请为该任务指定优先级。",
      )
    }
    if (
      active && issue.estimate == null &&
      issue.team.issueEstimationType !== "notUsed"
    ) {
      add(
        issue,
        "issue",
        "missing-estimate",
        severity,
        "estimate",
        "任务没有估时",
        "请填写该任务的估时。",
      )
    }
    if (
      !deferred && active && issue.cycle == null &&
      issue.team.cyclesEnabled === true && issue.team.activeCycle != null
    ) {
      add(
        issue,
        "issue",
        "missing-cycle",
        severity,
        "cycle",
        `任务没有周期；团队 ${issue.team.key} 已启用周期`,
        "请确认是否将该任务加入当前周期；暂不排期时可以留空。",
      )
    }
    if (started && Date.parse(issue.updatedAt) < now.getTime() - threshold) {
      add(
        issue,
        "issue",
        "stale-started",
        "P1",
        "stale",
        `进行中任务已至少 ${policy.staleDays} 天未更新`,
        "请确认该任务是否仍在推进；如已阻塞、拆分或完成，请更新状态和下一步。",
      )
    }
  }
  for (const project of projects) {
    if (!["started", "planned"].includes(project.status.type)) continue
    const severity = project.status.type === "planned" ? "P2" : "P1"
    if (
      project.lastUpdate == null &&
      now.getTime() - Date.parse(project.startedAt ?? project.createdAt) >=
        threshold
    ) {
      add(
        project,
        "project",
        "missing-project-update",
        severity,
        "project-update",
        `项目已超过 ${policy.staleDays} 天没有项目更新`,
        "请发布项目更新，或更新项目状态。",
      )
    }
    if (
      project.lastUpdate != null &&
      now.getTime() - Date.parse(project.lastUpdate.createdAt) >= threshold
    ) {
      const age = Math.floor(
        (now.getTime() - Date.parse(project.lastUpdate.createdAt)) / 86_400_000,
      )
      add(
        project,
        "project",
        "stale-project-update",
        severity,
        "project-update",
        `最近一次项目更新已是 ${age} 天前${
          project.lastUpdate.isStale ? "，并被 Linear 标记为过期" : ""
        }`,
        "请发布新的项目更新，或更新项目状态。",
      )
    }
    if (["atRisk", "offTrack"].includes(project.health)) {
      add(
        project,
        "project",
        "project-health-risk",
        severity,
        "health",
        `项目健康状态为「${
          project.health === "atRisk" ? "有风险" : "偏离计划"
        }」`,
        "请确认风险原因和下一步，并发布项目更新。",
      )
    }
  }
  findings.sort((a, b) =>
    a.severity.localeCompare(b.severity) || a.ruleId.localeCompare(b.ruleId) ||
    (a[a.target].identifier ?? a[a.target].name).localeCompare(
      b[b.target].identifier ?? b[b.target].name,
    )
  )
  return {
    schemaVersion: 1,
    scope,
    policy,
    scanned: { issueCount: scoped.length, projectCount: projects.length },
    summary: {
      findingCount: findings.length,
      bySeverity: Object.fromEntries(
        ["P0", "P1", "P2"].map((s) => [
          s,
          findings.filter((f) => f.severity === s).length,
        ]),
      ),
    },
    findings,
  }
}

async function readApi(query, variables = {}, paginate = false) {
  const result = await new Deno.Command(
    Deno.env.get("LINEAR_BIN") ?? "linear",
    {
      args: [
        "api",
        query,
        "--variables-json",
        JSON.stringify(variables),
        ...(paginate ? ["--paginate"] : []),
      ],
      stdout: "piped",
      stderr: "inherit",
    },
  ).output()
  if (!result.success) {
    throw new Error("CLI query failed; no partial report produced")
  }
  const envelope = JSON.parse(new TextDecoder().decode(result.stdout))
  if (envelope.errors?.length || envelope.data == null) {
    throw new Error("Incomplete GraphQL response")
  }
  return envelope.data
}

export async function collectDoctorData(scope, target, policy, api = readApi) {
  if (!["self", "team", "project", "workspace"].includes(scope)) {
    throw new Error("Scope must be self, team, project or workspace")
  }
  if (["team", "project"].includes(scope) !== Boolean(target)) {
    throw new Error("Only team and project scopes require a target")
  }
  const includeArchived = policy.includeArchived
  const issueFilter = policy.includeHistory
    ? {}
    : { state: { type: { in: ["started", "unstarted"] } } }
  const projectFilter = { status: { type: { in: ["started", "planned"] } } }
  if (scope === "self") {
    const { viewer } = await api("query DoctorViewer { viewer { id } }")
    issueFilter.assignee = { id: { eq: viewer.id } }
    projectFilter.issues = { some: issueFilter }
  } else if (scope === "team") {
    const key = target.toUpperCase()
    const { teams } = await api(
      "query DoctorTeam($key: String!) { teams(filter: {key: {eq: $key}}) { nodes {id key} } }",
      { key },
    )
    if (teams.nodes.length !== 1) {
      throw new Error(`Team not found or ambiguous: ${target}`)
    }
    issueFilter.team = { id: { eq: teams.nodes[0].id } }
    projectFilter.accessibleTeams = { some: { key: { eq: key } } }
  } else if (scope === "project") {
    // Complete the identity lookup before selecting one exact UUID, slug or name.
    const { projects } = await api(
      `query DoctorProjectTarget($after: String, $includeArchived: Boolean!) {
      projects(first: 100, after: $after, includeArchived: $includeArchived) {
        nodes { id slugId name } pageInfo { hasNextPage endCursor }
      }
    }`,
      { includeArchived },
      true,
    )
    const matches = projects.nodes.filter((p) =>
      p.id === target || p.slugId === target ||
      p.name.toLowerCase() === target.toLowerCase()
    )
    if (matches.length !== 1) {
      throw new Error(`Project not found or ambiguous: ${target}; use its UUID`)
    }
    issueFilter.project = { id: { eq: matches[0].id } }
    projectFilter.id = { eq: matches[0].id }
  }
  const wantsIssues = policy.selectedRules.some((id) =>
    doctorRuleIds.slice(0, 6).includes(id)
  )
  const wantsProjects = policy.selectedRules.some((id) =>
    doctorRuleIds.slice(6).includes(id)
  )
  let issues = []
  let projects = []
  if (wantsIssues) {
    const data = await api(
      `query DoctorIssues($filter: IssueFilter, $after: String, $includeArchived: Boolean!) {
      issues(filter: $filter, first: 100, after: $after, includeArchived: $includeArchived) {
        nodes { id identifier title url priority estimate updatedAt state { name type }
          team { id key cyclesEnabled issueEstimationType activeCycle { number } }
          cycle { id number } project { id name }
        } pageInfo { hasNextPage endCursor }
      }
    }`,
      { filter: issueFilter, includeArchived },
      true,
    )
    issues = data.issues.nodes.filter((i) =>
      policy.includeHistory || !terminal(i)
    )
    if (policy.selectedRules.includes("project-team-mismatch")) {
      const memberships = new Map()
      for (const issue of issues) {
        if (
          !issue.project || ["backlog", "triage"].includes(issue.state.type)
        ) continue
        if (!memberships.has(issue.project.id)) {
          const data = await api(
            `query DoctorProjectTeams($id: String!, $after: String) {
            project(id: $id) { teams(first: 100, after: $after, includeArchived: true) {
              nodes { key } pageInfo { hasNextPage endCursor }
            } }
          }`,
            { id: issue.project.id },
            true,
          )
          memberships.set(issue.project.id, data.project.teams)
        }
        issue.project.teams = memberships.get(issue.project.id)
      }
    }
  }
  if (wantsProjects) {
    const data = await api(
      `query DoctorProjects($filter: ProjectFilter, $after: String, $includeArchived: Boolean!) {
      projects(filter: $filter, first: 100, after: $after, includeArchived: $includeArchived) {
        nodes { id name createdAt startedAt status { name type } health healthUpdatedAt
          lastUpdate { createdAt updatedAt health isStale }
        } pageInfo { hasNextPage endCursor }
      }
    }`,
      { filter: projectFilter, includeArchived },
      true,
    )
    projects = scope === "self" && wantsIssues
      ? data.projects.nodes.filter((p) =>
        issues.some((i) => i.project?.id === p.id)
      )
      : data.projects.nodes
  }
  return { issues, projects }
}

if (import.meta.main) {
  try {
    const flags = parseArgs(Deno.args, {
      boolean: ["history", "include-archived", "json", "help"],
      string: ["rule", "stale-days", "limit"],
      collect: ["rule"],
      default: { "stale-days": "14", limit: "4" },
      unknown: (arg) => {
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
      },
    })
    if (flags.help) {
      console.log(
        "deno run --allow-run --allow-env recipes/doctor.js <self|team|project|workspace> [target] [--history] [--include-archived] [--rule ID] [--stale-days 14] [--limit 4] [--json]",
      )
      Deno.exit(0)
    }
    if (flags._.length > 2) throw new Error("Unexpected positional argument")
    const [scope, target] = flags._.map(String)
    const selectedRules = flags.rule.length ? flags.rule : doctorRuleIds
    if (selectedRules.some((r) => !doctorRuleIds.includes(r))) {
      throw new Error(`Unknown rule; choose from ${doctorRuleIds.join(", ")}`)
    }
    const policy = {
      includeHistory: flags.history,
      includeArchived: flags["include-archived"],
      staleDays: Number(flags["stale-days"]),
      selectedRules,
    }
    const limit = Number(flags.limit)
    if (
      !Number.isSafeInteger(policy.staleDays) || policy.staleDays < 1 ||
      !Number.isSafeInteger(limit) || limit < 0
    ) {
      throw new Error(
        "stale-days must be a positive integer; limit a non-negative integer",
      )
    }
    const { issues, projects } = await collectDoctorData(scope, target, policy)
    const report = evaluateDoctorIssues(
      issues,
      { kind: scope, ...(target ? { target } : {}) },
      policy,
      new Date(),
      projects,
    )
    if (flags.json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(
        `Scanned ${report.scanned.issueCount} issues and ${report.scanned.projectCount} projects; ${report.findings.length} findings (organization policy)`,
      )
      for (
        const finding of limit
          ? report.findings.slice(0, limit)
          : report.findings
      ) {
        const object = finding[finding.target]
        console.log(
          `${finding.severity} ${finding.ruleId} ${
            object.identifier ?? object.name
          }: ${finding.evidence}\n  ${finding.recommendation.text}`,
        )
      }
    }
  } catch (error) {
    console.error(error.message)
    Deno.exit(1)
  }
}
