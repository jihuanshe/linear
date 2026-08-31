---
name: automation
description: 无人值守执行、临时脚本编排、JSON 校验、Markdown 文件 flag 与写后读回验证
commands:
  - doctor
  - api
  - auth whoami
  - auth token
  - issue view
  - issue query
  - issue create
  - issue update
  - issue comment add
  - issue comment list
  - document view
---

# 无人值守执行与写入验证

输出要被程序消费，或写入结果需要核验时，读本指南。

## 输出契约

- `--json` 和 `--no-pager` 不是全局选项，按目标子命令的 `--help` 确认。
- 消费输出前：设 `NO_COLOR=1`，stdout 与 stderr 分开重定向，检查退出码，用 `jq -e` 验证后再使用：

```bash
NO_COLOR=1 linear issue view ENG-123 --json >result.json 2>error.log &&
  jq -e . result.json >/dev/null
```

- 绝不用 `2>&1` 合并流再喂给 JSON 解析器。
- 首选防线是 `--json`；`NO_COLOR=1` 只兜底，部分帮助、版本、错误和 Markdown 渲染路径仍可能输出 ANSI 序列。人类可读输出不是稳定协议。没有 `--json` 这类结构化输出且必须解析时，显式剥离 ANSI 并只解析文档化的值，不解析终端布局。
- 读取 document 正文用 `document view --raw` 绕过终端 Markdown 渲染；需要元数据加内容的结构化信封时用 `--json`。
- 交互提示在无人值守环境用 `LINEAR_PROMPT_DISABLED=1` 禁用；提示被禁用后缺输入的命令会失败而不是挂起。禁用提示不代表获得写入授权。
- 后续命令显式传 Issue 标识。`issue view` 等命令省略参数时会从当前 Git branch 推断目标，无人值守脚本在仓库 checkout 里可能因此打到错误的 Issue。

## 分页形状

`issue query --json` 返回连接对象，不是裸数组。节点在 `.nodes`，分页信息在 `.pageInfo`。`--limit` 超过单页大小或传 `0`（不设上限）时，CLI 自动翻页并拼接各页的 `nodes`，保留连接形状，不扁平化、不重命名字段：

```bash
jq -e '.nodes | arrays' project-issues.json >/dev/null &&
  jq '.nodes[] | {identifier, title, priority}' project-issues.json
```

`issue comment list --json` 同样返回 connection envelope `{nodes,pageInfo}`，而不是评论数组。例如：

```bash
linear issue comment list ENG-123 --json >comments.json &&
  jq -e '.nodes | arrays' comments.json >/dev/null &&
  jq '{comments: [.nodes[] | {id, body}], pageInfo}' comments.json
```

## Markdown 走文件 flag

多行 Markdown 一律用文件 flag：`issue create` / `issue update` 用 `--description-file`，`comment add` / `comment update` 用 `--body-file`。这避免 shell 转义破坏换行、防止字面 `\n` 进入正文。内联 flag（`--description`、`--body`）只用于单行内容。

```bash
cat > "$TMPDIR/description.md" <<'EOF'
## Summary

多行 Markdown 内容。
EOF
linear issue create --title "My Issue" --description-file "$TMPDIR/description.md"
```

## 写后读回

写入不以命令退出码为终点。用结构化读取核对本次修改的字段：

- 专用写命令无 `--json` 时，通过暴露相关字段的 `view` / `list` 读回；都不覆盖时用只读 `linear api` 查询验证。
- 只有人类输出可用时，核对文档化的值并明确说明「结果未经结构化验证」。
- 批量修改前后，把同一完整查询的 JSON 分别保存为快照：先比较排序后的 `.nodes[].identifier` 集合（不能只比数量），再按 identifier 比较本次涉及的目标字段。对新出现的 identifier 单独读取全文，不把旧快照的判断直接套用。

## 时序现实

AI 准备材料需要时间，期间上游对象可能已被他人修改。多步写入前重读目标当前值；发现与预期基线不符时停下报告差异，不盲目覆盖。

## 临时脚本编排

一次性审计或异构治理不需要新增一个永久命令。让 CLI 提供认证、结构化读取和 GraphQL 原语；先用 Bash 和 `jq` 组合简单查询，需要保存状态时再用临时 Python / TypeScript 编排。分类、取舍和授权不放进脚本默认值。

## 选择编排语言

| 任务形态                             | 选择                                          | 原因                                 |
| ------------------------------------ | --------------------------------------------- | ------------------------------------ |
| 读取、筛选、计数、格式化报告         | `linear ... --json` 加 `jq`，外面用 Bash 串联 | 无状态，数据只经过一次投影           |
| 一两个已确认的单条修改               | 直接调用专用 CLI 命令                         | CLI 已负责名称解析和输入校验         |
| 多次读取后生成审批表，或按目标值分组 | Python / TypeScript                           | 需要保留对象、基线和分组结果         |
| 批量写入、写后核对、未知结果停止     | Python / TypeScript                           | 需要明确处理批次、业务成功和恢复分支 |

不要为了「看起来像自动化」把简单的 `jq` 投影改写成 Python；也不要把 JSON 引号、循环状态和错误分支堆进长 Bash 脚本。脚本变长的原因是业务状态，而不是语言偏好。

推荐固定为这条流水线：

| 阶段 | 做什么                                                                       | 是否写远端 |
| ---- | ---------------------------------------------------------------------------- | ---------- |
| 读取 | 用 `doctor` 找问题，再用 `issue query --json` 读取要判断的完整字段           | 否         |
| 计划 | 脚本按标题、现有字段和证据生成表格或 `patch.json`                            | 否         |
| 审批 | 人确认每个补丁的目标值；未确认的条目留在计划中                               | 否         |
| 复核 | 写入前用 `auth whoami --json` 核对 workspace，并重读目标，发现基线变化就停止 | 否         |
| 写入 | 已有专用命令的字段逐条调用该命令；只有专用命令未覆盖的长尾操作才用 GraphQL   | 是         |
| 验证 | 用同一批目标做一次结构化读回，按 identifier 比较本次字段                     | 否         |

读取示例：

```bash
LINEAR_PROMPT_DISABLED=1 linear doctor self --history --limit 0 --json >doctor.json
LINEAR_PROMPT_DISABLED=1 linear issue query \
  --all-teams --assignee self --limit 0 --json >issues.json
```

脚本默认只生成计划，不把 finding 当作写入指令。已有专用写命令的字段逐条调用该命令；只有专用命令未覆盖、且确实需要 GraphQL mutation 时，目标值完全相同的条目才可以合并成一批。不同目标值必须分组，不能为了减少请求而覆盖成同一个值。批量修改 Issue 的边界见 [graphql](graphql.md)。

优先让脚本调用专用 CLI 命令，这样名称解析和输入校验仍由 CLI 负责。只有目标 mutation 没有专用命令覆盖时才调用 `linear api`，凭据仍由 CLI 解析，脚本不需要接触 token。只有直接 HTTP 确有必要时，才在进程内通过 `linear auth token` 读取 token；不要把 token 写入文件、日志、`.env` 或命令行参数。

批量写入遇到网络错误、超时或响应无法确认时，停止后续批次，先读回对账；不要把未知结果当成「未写入」再重试。
