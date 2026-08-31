---
name: doctor
description: 按个人、团队、项目或组织范围只读检查任务元数据、项目进展和流程停滞
commands:
  - doctor
---

# 检查 Linear 健康度

需要回答「哪里需要处理」，但还没有决定具体怎么改时使用 `doctor`。它只读 Linear，输出问题、证据和待确认的建议，不会自动修改任务或项目。

## 选择范围

| 命令                                         | 检查范围                                         |
| -------------------------------------------- | ------------------------------------------------ |
| `linear doctor self`                         | 当前认证用户负责的任务，以及与这些任务相关的项目 |
| `linear doctor team <team-key>`              | 一个团队的任务和项目                             |
| `linear doctor project <project-id-or-name>` | 一个项目的任务和项目进展                         |
| `linear doctor workspace`                    | 整个 workspace 的任务和项目                      |

默认只检查进行中和待办任务，以及进行中和计划中的项目。要把已完成、已合并、已取消和重复的任务纳入检查，显式加 `--history`：

```bash
linear doctor self --history
linear doctor workspace --history --limit 0 --json >doctor.json
```

`--include-archived` 才会纳入归档任务或项目。`--limit` 只限制人类可读报告中显示的问题；`--limit 0` 显示全部。`--stale-days <days>` 同时控制长期未更新任务和项目更新的过期阈值，默认是 14 天。

## 四个检查策略

| 策略     | 检查项                                                                  | 关注的问题                                     |
| -------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| 执行准备 | `missing-priority`、`missing-estimate`、`missing-cycle`                 | 可以开始做的任务是否有优先级、估时和必要的周期 |
| 项目进展 | `missing-project-update`、`stale-project-update`、`project-health-risk` | 项目是否持续发布 Pulse，健康状态是否有风险     |
| 任务归属 | `project-team-mismatch`、`missing-project`                              | 任务是否属于正确的项目和团队                   |
| 流程推进 | `stale-started`                                                         | 进行中任务是否长时间没有更新                   |

周期只在团队启用周期且存在当前周期时提示；积压和待分流任务不因没有周期而报警。项目进展只检查进行中和计划中的项目。历史任务的问题统一按较低严重度提示，不因为补填字段制造虚假的执行压力。

只运行指定检查项时重复传 `--rule`：

```bash
linear doctor self \
  --rule missing-project \
  --rule project-team-mismatch \
  --rule stale-started \
  --limit 0
```

可用的规则 ID 以 `doctor` 的校验错误和源码版本为准；传入未知 ID 会失败，不会静默忽略。

## 读懂输出

人类输出按严重度、生命周期和规则排序。JSON 报告的 `schemaVersion` 当前为 `1`，常用字段如下：

```bash
jq -e '.schemaVersion == 1 and (.findings | arrays)' doctor.json >/dev/null
jq '.strategySummaries[] | {name, findingCount, affectedResourceCount}' doctor.json
jq '.findings[] | {target, ruleId, severity, field, evidence}' doctor.json
```

`summary` 是总数，`strategySummaries` 适合先找影响面最大的策略，`findings` 才是逐条任务或项目的证据。每条 finding 都带 `recommendation.needsHumanDecision: true`：它是待审提示，不是可直接执行的补丁。

## 从提示到处理

先读完整报告，再由人和 AI 确认项目、优先级、估时、周期或标签等具体值。一次性处理多条任务时，按 [automation](automation.md) 指南生成临时审批表和补丁；不要把 `doctor` 输出直接接到写入命令，也不要因为报告有问题就自动补齐元数据。
