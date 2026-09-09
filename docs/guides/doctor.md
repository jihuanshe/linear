---
name: doctor
description: 使用只读 recipe 选择治理范围、解释九类候选并复查结果
commands:
  - api
  - issue query
---

# 检查 Linear 健康度

组织策略位于可编辑的 [doctor recipe](../../recipes/doctor.js)。在与已安装 CLI 同版本的仓库中运行；`LINEAR_BIN` 可以指定独立安装产物的绝对路径。脚本通过 `linear api --paginate` 完整读取，不直接访问网络，不执行写入。recipe 的运行与文件准备见 [recipes](../../recipes/README.md)。

## 选择范围

```bash
deno run --allow-run --allow-env recipes/doctor.js self --json >doctor.json
# 将 self 替换为 team ENG、project <UUID/slug/name> 或 workspace。
```

四个范围分别是本人负责的任务及相关项目、指定团队、指定项目、整个 workspace。项目名必须精确且唯一；重名时使用 UUID。

默认纳入进行中和待办任务，并排除名称为 Merged 的历史任务；`--history` 取消任务状态过滤，`--include-archived` 独立纳入归档对象。项目进展规则只检查进行中和计划中的项目，history 不扩大这些规则的范围。项目与团队归属检查始终包含归档团队。

`--limit` 只限制人类报告显示数量，不限制扫描或 JSON；默认 4，0 显示全部。`--stale-days` 控制停滞与项目更新阈值，默认 14 天。各页读取不保证来自同一数据库时刻。

## 解释候选

九类判断保留为脚本中的普通条件：project-team-mismatch、missing-project、missing-priority、missing-estimate、missing-cycle、stale-started、missing-project-update、stale-project-update、project-health-risk。可重复传 `--rule` 缩小检查范围。

```bash
deno run --allow-run --allow-env recipes/doctor.js self \
  --rule missing-project --rule project-team-mismatch --json >doctor.json
jq '.findings[] | {target, id: (.issue.id // .project.id), ruleId, severity, field, evidence}' doctor.json
```

`summary` 汇总严重度，`findings` 保留对象与逐项证据，按严重度、规则、对象排序。P0/P1/P2 是这份 recipe 的组织策略；不是 Linear 的缺陷等级或必填约束。报告不含可执行补丁，建议保留 `needsHumanDecision: true`。

缺周期只在团队启用周期且存在当前周期时提示；积压与待分流任务豁免。团队不使用估时时不要求估时。历史任务采用较低严重度。项目已被 Linear 标记过期仍须达到本次时间阈值才命中。结合约定和证据决定处理方式，保留不处理的原因。

## 复查结果

沿用相同 scope、history、archive、rule 和阈值，比较 `(target, 对象 ID, ruleId)` 命中集合。候选数减少不能单独证明修复；实际写入与字段读回见 [automation](automation.md)。
