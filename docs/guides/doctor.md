---
name: doctor
description: 选择健康检查范围、解释候选问题并复查治理结果
commands:
  - doctor
---

# 检查 Linear 健康度

`doctor` 只读发现任务和项目中的治理候选，返回证据与建议。

## 选择范围

| 命令                                         | 检查范围                     |
| -------------------------------------------- | ---------------------------- |
| `linear doctor self`                         | 当前用户负责的任务及相关项目 |
| `linear doctor team <team-key>`              | 团队的任务和项目             |
| `linear doctor project <project-id-or-name>` | 项目的任务与进展             |
| `linear doctor workspace`                    | workspace 的任务和项目       |

默认纳入进行中和待办任务；`--history` 取消任务状态过滤，`--include-archived` 另行纳入归档对象。项目进展规则只检查进行中和计划中的项目，`--history` 不扩大这些规则的适用范围。

`--limit` 只限制人类报告的显示数量，不限制扫描或 JSON；`--limit 0` 显示全部。`--stale-days` 控制任务停滞与项目更新过期阈值，默认 14 天。

## 解释候选

```bash
linear doctor self --json >doctor.json &&
  jq -e '.schemaVersion == 1 and (.findings | type == "array")' doctor.json >/dev/null &&
  jq '.strategySummaries[] | {name, rules, findingCount, affectedResourceCount}' doctor.json &&
  jq '.findings[] | {target, id: (.issue.id // .project.id), ruleId, severity, field, evidence}' doctor.json
```

`strategySummaries` 提供执行准备、项目进展、任务归属和流程推进四类检查的规则及汇总；`findings` 是逐项证据。缩小检查范围时，从报告的 `strategySummaries[].rules[].ruleId` 选择，可重复传 `--rule`：

```bash
linear doctor self --rule missing-project --rule project-team-mismatch --limit 0
```

候选不等于必须补字段。例如缺少周期只在团队启用周期且存在当前周期时提示，积压和待分流任务豁免；历史任务按较低严重度提示。结合 workspace 约定和证据决定是否修改，保留不处理的原因。

## 复查治理结果

报告不含可执行补丁；`recommendation.needsHumanDecision: true` 标记需要判断的建议。已有明确规则、证据和授权的项可连续处理，未决项集中确认，执行与字段读回见 [automation](automation.md)。

复查沿用相同范围和 `--rule`，比较 `(target, 对象 ID, ruleId)` 命中集合，并保存忽略原因与待确认项。候选数量减少不能单独证明修复。
