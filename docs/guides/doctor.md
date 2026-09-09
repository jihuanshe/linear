---
name: doctor
description: 解释只读健康检查的候选，保留判断依据并复查结果
commands:
  - api
  - issue query
---

# 解释健康检查结果

健康检查使用可编辑的工作流示例。运行 `linear recipe doctor` 读取范围、依赖、运行步骤与规则说明；用 `linear recipe doctor --source` 取得完整脚本。查看和导出均从二进制内读取，不访问网络或执行脚本。

## 判断候选

报告中的 `summary` 汇总严重度，`findings` 保留对象和逐项证据。`ruleId` 标明命中的规则，`severity` 表示示例定义的严重度。P0／P1／P2 是可修改的组织约定，不能作为 Linear 的必填约束或缺陷等级。

```bash
jq '.findings[] | {target, id: (.issue.id // .project.id), ruleId, severity, field, evidence}' doctor.json
```

结合团队约定和现场证据决定是否处理，保留不处理的原因。缺少某个字段不自动证明工作无法推进；历史任务与活跃任务也可能采用不同标准。报告不含可执行补丁，`needsHumanDecision: true` 表示仍须作出业务判断。

## 复查结果

使用相同范围、`--history`、`--include-archived`、`--rule` 和时间阈值，比较 `(target, 对象 ID, ruleId)` 命中集合。候选数减少不能单独证明修复；实际写入与字段读回见 `linear guide automation`。
