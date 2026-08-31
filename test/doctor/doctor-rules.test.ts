import { assertEquals } from "@std/assert"
import { evaluateDoctorIssues } from "../../src/doctor/engine.ts"
import { formatDoctorReport } from "../../src/doctor/output.ts"
import { doctorRuleIds } from "../../src/doctor/rules.ts"
import type {
  DoctorIssue,
  DoctorPolicy,
  DoctorProject,
  DoctorScope,
} from "../../src/doctor/types.ts"

const scope: DoctorScope = { kind: "self", target: "self" }

function makePolicy(
  includeHistory = false,
  selectedRules = doctorRuleIds,
  staleDays = 14,
): DoctorPolicy {
  return {
    includeHistory,
    includeArchived: false,
    staleDays,
    backlogCycleRequired: false,
    selectedRules,
  }
}

function makeIssue(options: {
  identifier?: string
  title?: string
  stateType?: string
  stateName?: string
  priority?: number
  estimate?: number | null
  updatedAt?: string
  projectName?: string | null
  projectTeams?: string[]
  projectTeamsHasNextPage?: boolean
  issueEstimationType?: string
  cycle?: DoctorIssue["cycle"]
  cyclesEnabled?: boolean
  activeCycle?: number | null
} = {}): DoctorIssue {
  const projectName = options.projectName === undefined
    ? "Project"
    : options.projectName
  return {
    id: `id-${options.identifier ?? "JHS-1"}`,
    identifier: options.identifier ?? "JHS-1",
    title: options.title ?? "Test issue",
    url: "https://linear.app/test/issue/JHS-1/test-issue",
    priority: options.priority ?? 2,
    priorityLabel: options.priority === 0 ? "No priority" : "High",
    estimate: options.estimate === undefined ? 1 : options.estimate,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-08-29T00:00:00.000Z",
    state: {
      id: "state-1",
      name: options.stateName ?? "In Progress",
      color: "#f2c94c",
      type: options.stateType ?? "started",
    },
    assignee: {
      id: "user-1",
      name: "alex",
      displayName: "Alex",
      initials: "AL",
    },
    team: {
      id: "team-1",
      key: "JHS",
      name: "集换社",
      cyclesEnabled: options.cyclesEnabled ?? true,
      issueEstimationType: options.issueEstimationType ?? "fibonacci",
      activeCycle: options.activeCycle === null
        ? null
        : { number: options.activeCycle ?? 16 },
    },
    project: projectName == null ? null : {
      id: "project-1",
      name: projectName,
      teams: {
        nodes: (options.projectTeams ?? ["JHS"]).map((key) => ({ key })),
        pageInfo: {
          hasNextPage: options.projectTeamsHasNextPage ?? false,
          endCursor: null,
        },
      },
    },
    projectMilestone: null,
    cycle: options.cycle === undefined
      ? {
        id: "cycle-1",
        number: 16,
        name: "Cycle 16",
        isActive: true,
        isNext: false,
        isPrevious: false,
        isFuture: false,
        isPast: false,
      }
      : options.cycle,
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
  }
}

function makeProject(options: {
  name?: string
  createdAt?: string
  startedAt?: string | null
  statusType?: string
  statusName?: string
  health?: DoctorProject["health"]
  healthUpdatedAt?: string | null
  lastUpdate?: DoctorProject["lastUpdate"]
} = {}): DoctorProject {
  return {
    id: `project-${options.name ?? "test"}`,
    name: options.name ?? "Test Project",
    createdAt: options.createdAt ?? "2026-08-01T00:00:00.000Z",
    startedAt: options.startedAt === undefined
      ? "2026-08-01T00:00:00.000Z"
      : options.startedAt,
    status: {
      name: options.statusName ?? "Started",
      type: options.statusType ?? "started",
    },
    health: options.health ?? "onTrack",
    healthUpdatedAt: options.healthUpdatedAt === undefined
      ? "2026-08-01T00:00:00.000Z"
      : options.healthUpdatedAt,
    lastUpdate: options.lastUpdate === undefined
      ? {
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
        health: "onTrack",
        isStale: false,
      }
      : options.lastUpdate,
  }
}

const now = new Date("2026-08-30T00:00:00.000Z")

Deno.test("Doctor rules respect lifecycle-aware defaults", () => {
  const backlog = makeIssue({
    stateType: "backlog",
    stateName: "Backlog",
    estimate: null,
    cycle: null,
  })
  const report = evaluateDoctorIssues(
    [backlog],
    scope,
    makePolicy(),
    now,
  )

  assertEquals(report.scanned.issueCount, 1)
  assertEquals(report.findings, [])
})

Deno.test("Doctor rules report missing execution metadata", () => {
  const issue = makeIssue({
    identifier: "JHS-2",
    stateType: "unstarted",
    stateName: "Todo",
    estimate: null,
    cycle: null,
  })
  const report = evaluateDoctorIssues([issue], scope, makePolicy(), now)

  assertEquals(
    report.findings.map((finding) => finding.ruleId),
    ["missing-cycle", "missing-estimate"],
  )
  assertEquals(report.summary.bySeverity.P2, 2)
  assertEquals(
    report.strategySummaries.map((strategy) => strategy.id),
    [
      "execution-readiness",
      "project-pulse",
      "ownership-and-classification",
      "flow-progress",
    ],
  )
  assertEquals(report.strategySummaries[0].findingCount, 2)
  assertEquals(report.strategySummaries[0].affectedResourceCount, 1)
  assertEquals(report.strategySummaries[0].bySeverity, { P0: 0, P1: 0, P2: 2 })
  assertEquals(
    report.strategySummaries[0].rules.map((rule) => rule.ruleId),
    ["missing-priority", "missing-estimate", "missing-cycle"],
  )
  assertEquals(
    report.strategySummaries[0].representativeFinding?.reference,
    "JHS-2",
  )
})

Deno.test("Doctor rules identify project and team mismatches", () => {
  const issue = makeIssue({ projectTeams: ["ARCH"] })
  const report = evaluateDoctorIssues([issue], scope, makePolicy(), now)

  assertEquals(report.findings.length, 1)
  assertEquals(report.findings[0].ruleId, "project-team-mismatch")
  assertEquals(report.findings[0].severity, "P0")
})

Deno.test("Doctor excludes terminal issues unless history is requested", () => {
  const issue = makeIssue({
    identifier: "JHS-3",
    stateType: "started",
    stateName: "Merged",
    projectName: null,
    priority: 0,
    estimate: null,
    cycle: null,
  })
  const currentReport = evaluateDoctorIssues(
    [issue],
    scope,
    makePolicy(),
    now,
  )
  const historyReport = evaluateDoctorIssues(
    [issue],
    scope,
    makePolicy(true),
    now,
  )

  assertEquals(currentReport.scanned.issueCount, 0)
  assertEquals(currentReport.findings, [])
  assertEquals(historyReport.scanned.issueCount, 1)
  assertEquals(historyReport.findings.length, 4)
})

Deno.test("Doctor reports stale In Progress issues", () => {
  const issue = makeIssue({
    identifier: "JHS-4",
    updatedAt: "2026-08-01T00:00:00.000Z",
  })
  const report = evaluateDoctorIssues([issue], scope, makePolicy(), now)

  assertEquals(report.findings.length, 1)
  assertEquals(report.findings[0].ruleId, "stale-started")
})

Deno.test("Doctor can run a selected rule only", () => {
  const issue = makeIssue({
    identifier: "JHS-5",
    stateType: "unstarted",
    stateName: "Todo",
    estimate: null,
    cycle: null,
  })
  const report = evaluateDoctorIssues(
    [issue],
    scope,
    makePolicy(false, ["missing-estimate"]),
    now,
  )

  assertEquals(report.findings.map((finding) => finding.ruleId), [
    "missing-estimate",
  ])
  assertEquals(report.strategySummaries[0].findingCount, 1)
  assertEquals(report.strategySummaries[0].rules.map((rule) => rule.ruleId), [
    "missing-estimate",
  ])
  assertEquals(report.strategySummaries.length, 1)
})

Deno.test("Doctor human output expands findings in a four-item batch", () => {
  const issue = makeIssue({
    identifier: "JHS-6",
    stateType: "unstarted",
    stateName: "Todo",
    projectName: null,
    priority: 0,
    estimate: null,
    cycle: null,
  })
  const secondIssue = makeIssue({
    identifier: "JHS-7",
    stateType: "unstarted",
    stateName: "Todo",
    projectName: null,
    priority: 0,
    estimate: null,
    cycle: null,
  })
  const report = evaluateDoctorIssues(
    [issue, secondIssue],
    scope,
    makePolicy(),
    now,
  )
  const output = formatDoctorReport(report, 4).join("\n")

  assertEquals(
    output.includes("治理概览（4 项）"),
    true,
  )
  assertEquals(output.includes("执行准备"), true)
  assertEquals(output.includes("任务归属"), true)
  assertEquals(output.includes("4×4"), false)
  assertEquals(output.includes("治理杠杆"), false)
  assertEquals(output.includes("Doctor 不"), false)
  assertEquals(output.includes("展开问题：4 / 8"), true)
  assertEquals(output.match(/建议：/g)?.length, 4)
})

Deno.test("Doctor reports missing and stale Project Updates", () => {
  const missing = makeProject({
    name: "Missing Update",
    lastUpdate: null,
  })
  const stale = makeProject({
    name: "Stale Update",
    lastUpdate: {
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      health: "onTrack",
      isStale: false,
    },
  })
  const report = evaluateDoctorIssues(
    [],
    scope,
    makePolicy(),
    now,
    [missing, stale],
  )

  assertEquals(
    report.findings.map((finding) => finding.ruleId),
    ["missing-project-update", "stale-project-update"],
  )
  assertEquals(
    report.findings.every((finding) => finding.target === "project"),
    true,
  )
  assertEquals(report.summary.bySeverity.P1, 2)
})

Deno.test("Doctor reports risky Project health", () => {
  const project = makeProject({
    health: "atRisk",
    lastUpdate: {
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      health: "atRisk",
      isStale: false,
    },
  })
  const report = evaluateDoctorIssues(
    [],
    scope,
    makePolicy(false, ["project-health-risk"]),
    now,
    [project],
  )

  assertEquals(report.findings.length, 1)
  assertEquals(report.findings[0].ruleId, "project-health-risk")
  assertEquals(report.findings[0].severity, "P1")
})

Deno.test("Doctor exempts young and inactive Projects from Pulse findings", () => {
  const projects = [
    makeProject({
      name: "Young",
      createdAt: "2026-08-25T00:00:00.000Z",
      startedAt: "2026-08-25T00:00:00.000Z",
      lastUpdate: null,
    }),
    makeProject({
      name: "Backlog",
      statusType: "backlog",
      statusName: "Backlog",
      lastUpdate: null,
    }),
    makeProject({
      name: "Paused",
      statusType: "paused",
      statusName: "Paused",
      health: "offTrack",
      lastUpdate: null,
    }),
  ]
  const report = evaluateDoctorIssues([], scope, makePolicy(), now, projects)

  assertEquals(report.scanned.projectCount, 3)
  assertEquals(report.findings, [])
})

Deno.test("Doctor keeps terminal Projects out of Pulse with history", () => {
  const projects = [
    makeProject({
      name: "Completed",
      statusType: "completed",
      statusName: "Completed",
      health: "atRisk",
      lastUpdate: null,
    }),
    makeProject({
      name: "Canceled",
      statusType: "canceled",
      statusName: "Canceled",
      health: "offTrack",
      lastUpdate: null,
    }),
  ]
  const report = evaluateDoctorIssues(
    [],
    scope,
    makePolicy(true),
    now,
    projects,
  )

  assertEquals(report.findings, [])
})

Deno.test("Doctor skips priority and team checks for Backlog and Triage", () => {
  const issues = [
    makeIssue({
      identifier: "JHS-8",
      stateType: "backlog",
      stateName: "Backlog",
      priority: 0,
      projectTeams: ["ARCH"],
    }),
    makeIssue({
      identifier: "JHS-9",
      stateType: "triage",
      stateName: "Triage",
      priority: 0,
      projectTeams: ["ARCH"],
    }),
  ]
  const report = evaluateDoctorIssues(issues, scope, makePolicy(), now)

  assertEquals(report.findings, [])
})

Deno.test("Doctor skips missing estimates when the team does not use estimates", () => {
  const issue = makeIssue({
    estimate: null,
    issueEstimationType: "notUsed",
  })
  const report = evaluateDoctorIssues(
    [issue],
    scope,
    makePolicy(false, ["missing-estimate"]),
    now,
  )

  assertEquals(report.findings, [])
})

Deno.test("Doctor does not let Linear stale markers bypass the configured threshold", () => {
  const project = makeProject({
    lastUpdate: {
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      health: "onTrack",
      isStale: true,
    },
  })
  const report = evaluateDoctorIssues(
    [],
    scope,
    makePolicy(false, ["stale-project-update"], 30),
    now,
    [project],
  )

  assertEquals(report.findings, [])
})

Deno.test("Doctor does not report mismatches from an incomplete project team connection", () => {
  const issue = makeIssue({
    projectTeams: ["ARCH"],
    projectTeamsHasNextPage: true,
  })
  const report = evaluateDoctorIssues(
    [issue],
    scope,
    makePolicy(false, ["project-team-mismatch"]),
    now,
  )

  assertEquals(report.findings, [])
})
