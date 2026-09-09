# 运行可修改的只读治理检查

按一套明确的组织规则检查任务和项目时使用。脚本通过 `linear api --paginate` 读取数据，输出候选与证据，不执行写入。命中项不等于缺陷，也不直接产生修复补丁。

执行需要 Deno 和当前 `linear`；`LINEAR_BIN` 可以固定 CLI 的绝对路径。脚本使用固定版本的 Deno 标准库参数解析模块，不依赖源码仓库或其配置；首次执行时 Deno 可能需要获取该依赖。仅从 CLI 读取说明或源码不需要 Deno 和网络。

```sh
linear recipe doctor --source > doctor.js
deno run --allow-run --allow-env doctor.js self --json >doctor.json
# 其他范围：team ENG、project <UUID/slug/name>、workspace。
```

四个范围分别是本人负责的任务及相关项目、指定团队、指定项目、整个工作区。项目名必须精确且唯一；重名时使用 UUID。

默认纳入进行中和待办任务，排除名称为 Merged 的历史任务。`--history` 取消任务状态过滤；`--include-archived` 独立纳入归档对象。项目进展规则只检查进行中和计划中的项目，history 不扩大这些规则的范围。项目与团队归属检查始终包含归档团队。

`--limit` 只限制人类报告的显示数量，不限制扫描或 JSON；默认 4，0 显示全部。`--stale-days` 控制停滞与项目更新阈值，默认 14 天。跨页读取不保证来自同一数据库时刻。

九条规则是脚本中的普通条件：`project-team-mismatch`、`missing-project`、`missing-priority`、`missing-estimate`、`missing-cycle`、`stale-started`、`missing-project-update`、`stale-project-update`、`project-health-risk`。可重复传 `--rule`：

```sh
deno run --allow-run --allow-env doctor.js self \
  --rule missing-project --rule project-team-mismatch --json >doctor.json
jq '.findings[] | {target, id: (.issue.id // .project.id), ruleId, severity, field, evidence}' doctor.json
```

`summary` 汇总严重度，`findings` 保存对象与逐项证据，按严重度、规则、对象排序。P0/P1/P2 是这份示例的组织策略，不是 Linear 的缺陷等级或必填约束。策略不适合本团队时修改导出的脚本；解释候选及复查方法见 `linear guide doctor`。
