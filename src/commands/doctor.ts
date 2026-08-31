import { Command, EnumType } from "@cliffy/command"
import { withUsageMetadata } from "./usage.ts"
import { gql } from "../__codegen__/gql.ts"
import {
  fetchIssuesForQuery,
  getProjectIdByName,
  getProjectOptionsByName,
  getTeamIdByKey,
  isLinearUuid,
} from "../utils/linear.ts"
import { handleError, NotFoundError, ValidationError } from "../utils/errors.ts"
import { getGraphQLClient } from "../utils/graphql.ts"
import { evaluateDoctorIssues } from "../doctor/engine.ts"
import { fetchProjectsForDoctor } from "../doctor/projects.ts"
import {
  doctorProjectRules,
  doctorRuleIds,
  doctorRules,
} from "../doctor/rules.ts"
import { formatDoctorReport } from "../doctor/output.ts"
import type {
  DoctorIssue,
  DoctorPolicy,
  DoctorProject,
  DoctorRuleId,
  DoctorScope,
  DoctorScopeKind,
} from "../doctor/types.ts"

const ScopeType = new EnumType(["self", "team", "project", "workspace"])

const GetDoctorProjectTarget = gql(`
  query GetDoctorProjectTarget($id: String!) {
    project(id: $id) {
      id
    }
  }
`)

async function resolveUniqueProjectId(input: string): Promise<string> {
  if (isLinearUuid(input)) {
    const result = await getGraphQLClient().request(GetDoctorProjectTarget, {
      id: input,
    })
    if (result.project == null) throw new NotFoundError("Project", input)
    return result.project.id
  }

  const options = await getProjectOptionsByName(input)
  const exactMatches = Object.entries(options).filter(([, name]) =>
    name.toLowerCase() === input.toLowerCase()
  )

  if (exactMatches.length > 1) {
    throw new ValidationError(`Project name is ambiguous: ${input}`, {
      suggestion: "Use the Project UUID or slug ID instead.",
    })
  }
  if (exactMatches.length === 1) return exactMatches[0][0]

  const projectId = await getProjectIdByName(input)
  if (projectId == null) throw new NotFoundError("Project", input)
  return projectId
}

function validateTarget(
  scope: DoctorScopeKind,
  target: string | undefined,
): void {
  const needsTarget = scope === "team" || scope === "project"
  if (needsTarget && target == null) {
    throw new ValidationError(`doctor ${scope} requires a target`, {
      suggestion: scope === "team"
        ? "Use `linear doctor team <team-key>`."
        : "Use `linear doctor project <project-id-or-name>`.",
    })
  }
  if (!needsTarget && target != null) {
    throw new ValidationError(`doctor ${scope} does not accept a target`)
  }
}

function normalizeRules(ruleFlags: string[] | undefined): DoctorRuleId[] {
  const rules = ruleFlags == null
    ? [...doctorRuleIds]
    : (Array.isArray(ruleFlags) ? ruleFlags.flat() : [ruleFlags])
  const invalid = rules.filter((rule) =>
    !doctorRuleIds.includes(rule as DoctorRuleId)
  )
  if (invalid.length > 0) {
    throw new ValidationError(`未知检查项：${invalid[0]}`, {
      suggestion: `可用检查项：${doctorRuleIds.join(", ")}`,
    })
  }
  return rules as DoctorRuleId[]
}

export const doctorCommand = withUsageMetadata(new Command(), {
  outputModes: ["human", "json"],
})
  .name("doctor")
  .description("检查 Linear 任务和项目中的常见问题（只读）")
  .type("scope", ScopeType)
  .arguments("<scope:scope> [target:string]")
  .option(
    "--history",
    "包含已完成、已合并、已取消和重复的历史任务",
  )
  .option("--include-archived", "包含归档任务")
  .option(
    "--limit <limit:number>",
    "显示的问题数量（默认：4，使用 0 显示全部）",
    { default: 4 },
  )
  .option(
    "--rule <rule:string>",
    "只运行指定检查项（可重复）",
    { collect: true },
  )
  .option(
    "--stale-days <days:number>",
    "超过多少天未更新视为长期未更新（默认：14）",
    { default: 14 },
  )
  .option("-j, --json", "以 JSON 输出完整报告")
  .action(async (options, scope: DoctorScopeKind, target?: string) => {
    try {
      const {
        history,
        includeArchived,
        limit,
        rule,
        staleDays,
        json,
      } = options

      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new ValidationError("--limit must be a non-negative integer")
      }
      if (!Number.isSafeInteger(staleDays) || staleDays < 1) {
        throw new ValidationError("--stale-days must be a positive integer")
      }

      validateTarget(scope, target)
      const selectedRules = normalizeRules(rule)
      const shouldScanIssues = doctorRules.some((issueRule) =>
        selectedRules.includes(issueRule.id)
      )
      const shouldScanProjects = doctorProjectRules.some((projectRule) =>
        selectedRules.includes(projectRule.id)
      )

      let issueOptions: Parameters<typeof fetchIssuesForQuery>[0] | undefined
      let doctorScope: DoctorScope
      let projectId: string | undefined
      switch (scope) {
        case "self":
          if (shouldScanIssues) {
            issueOptions = {
              allTeams: true,
              assignee: "self",
              state: history === true ? undefined : ["started", "unstarted"],
              limit: 0,
              includeArchived,
            }
          }
          doctorScope = { kind: "self", target: "self" }
          break
        case "team": {
          const teamKey = target!.toUpperCase()
          const teamId = await getTeamIdByKey(teamKey)
          if (teamId == null) throw new NotFoundError("Team", teamKey)
          if (shouldScanIssues) {
            issueOptions = {
              teamKeys: [teamKey],
              state: history === true ? undefined : ["started", "unstarted"],
              limit: 0,
              includeArchived,
            }
          }
          doctorScope = { kind: "team", target: teamKey }
          break
        }
        case "project": {
          projectId = await resolveUniqueProjectId(target!)
          if (shouldScanIssues) {
            issueOptions = {
              allTeams: true,
              projectId,
              state: history === true ? undefined : ["started", "unstarted"],
              limit: 0,
              includeArchived,
            }
          }
          doctorScope = { kind: "project", target: target! }
          break
        }
        case "workspace":
          if (shouldScanIssues) {
            issueOptions = {
              allTeams: true,
              state: history === true ? undefined : ["started", "unstarted"],
              limit: 0,
              includeArchived,
            }
          }
          doctorScope = { kind: "workspace" }
          break
      }

      const issues: DoctorIssue[] = issueOptions == null
        ? []
        : (await fetchIssuesForQuery(issueOptions)).nodes
      let projects: DoctorProject[] = []
      if (shouldScanProjects) {
        let projectOptions: Parameters<typeof fetchProjectsForDoctor>[0] = {
          includeArchived,
        }
        if (scope === "team") {
          projectOptions = {
            teamKey: target!.toUpperCase(),
            includeArchived,
          }
        } else if (scope === "project") {
          projectOptions = {
            projectId,
            includeArchived,
          }
        } else if (scope === "self" && !shouldScanIssues) {
          projectOptions = {
            assignee: "self",
            includeArchived,
          }
        }

        const fetchedProjects = await fetchProjectsForDoctor(projectOptions)
        projects = scope === "self" && shouldScanIssues
          ? fetchedProjects.filter((project) =>
            issues.some((issue) => issue.project?.id === project.id)
          )
          : fetchedProjects
      }
      const policy: DoctorPolicy = {
        includeHistory: history === true,
        includeArchived: includeArchived === true,
        staleDays,
        backlogCycleRequired: false,
        selectedRules,
      }
      const report = evaluateDoctorIssues(
        issues,
        doctorScope,
        policy,
        new Date(),
        projects,
      )

      if (json) {
        console.log(JSON.stringify(report, null, 2))
        return
      }

      for (const line of formatDoctorReport(report, limit)) {
        console.log(line)
      }
    } catch (error) {
      handleError(error, "检查 Linear 数据失败")
    }
  })
