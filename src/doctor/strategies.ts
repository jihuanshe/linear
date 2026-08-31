import type { DoctorStrategyDefinition, DoctorStrategyId } from "./types.ts"

export const doctorStrategies: DoctorStrategyDefinition[] = [
  {
    id: "execution-readiness",
    name: "执行准备",
    purpose: "让可以开始做的任务有优先级、估时和周期。",
    ruleIds: ["missing-priority", "missing-estimate", "missing-cycle"],
    lifecycle: "进行中 / 待办；积压和待分流状态按规则跳过。",
    defaultThreshold: "优先级、估时，以及启用周期的团队对应的周期。",
  },
  {
    id: "project-pulse",
    name: "项目进展",
    purpose: "让项目进展和风险及时可见。",
    ruleIds: [
      "missing-project-update",
      "stale-project-update",
      "project-health-risk",
    ],
    lifecycle: "进行中 / 计划中项目；积压和暂停状态按规则跳过。",
    defaultThreshold: "项目更新默认 14 天内；健康状态不应为有风险或偏离计划。",
  },
  {
    id: "ownership-and-classification",
    name: "任务归属",
    purpose: "确保任务属于正确的项目和团队。",
    ruleIds: ["project-team-mismatch", "missing-project"],
    lifecycle: "进行中 / 待办；终态只在 --history 下检查。",
    defaultThreshold:
      "有项目时必须包含任务所属团队；需要归类的任务必须有项目。",
  },
  {
    id: "flow-progress",
    name: "流程推进",
    purpose: "发现长时间没有更新的进行中任务。",
    ruleIds: ["stale-started"],
    lifecycle: "进行中。",
    defaultThreshold: "默认 14 天没有更新视为长期未更新。",
  },
]

export const doctorStrategyIds: DoctorStrategyId[] = doctorStrategies.map(
  (strategy) => strategy.id,
)
