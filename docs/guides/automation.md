---
name: automation
description: 无人值守执行、临时脚本编排、JSON 校验、Markdown 文件 flag 与写后读回验证
commands:
  - doctor
  - api
  - auth whoami
  - auth token
  - issue view
  - issue history
  - issue query
  - issue create
  - issue update
  - issue comment add
  - issue comment update
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

批量操作先明确目标 workspace、输入范围和写入范围；得到授权后，脚本或 AI 在该范围内连续执行。输入分歧放进结果报告，认证、workspace 不一致和写入结果不明则停止相关批次并先回读对账。

## 分页形状

`issue query --json` 返回连接对象，不是裸数组。节点在 `.nodes`，分页信息在 `.pageInfo`。`--limit` 超过单页大小或传 `0`（不设上限）时，CLI 自动翻页并拼接各页的 `nodes`，保留连接形状，不扁平化、不重命名字段：

```bash
jq -e '.nodes | arrays' project-issues.json >/dev/null &&
jq '.nodes[] | {identifier, title, priority}' project-issues.json
```

按外部对象的 canonical URL 查重时使用 `issue query --url <url> --all-teams --json`。

它不会走 `--search` 的相关性排序：Linear Issue URL 按 identifier 和 workspace 定位，其他 URL 对候选 Issue description 或评论做完整 URL 边界核对。

空 `.nodes` 才表示当前没有命中。该模式已经读完候选分页并返回全部精确命中，有限 `--limit` 不会截断结果；`pageInfo` 固定为 `{hasNextPage:false,endCursor:null}`。

需要一次核对多个外部对象时，把每个 canonical URL 放在文件的一行，用 `--url-file`：

```bash
NO_COLOR=1 LINEAR_PROMPT_DISABLED=1 linear issue query --all-teams --url-file object-urls.txt --json >url-lookups.json
jq '.lookups[] | {url, identifiers: [.nodes[].identifier]}' url-lookups.json
```

空行和以 `#` 开头的行会忽略，重复 URL 只查一次；JSON 输出保持首次出现顺序，逐项返回 `{url,nodes,pageInfo}`。单个 `--url` 返回 `{nodes,pageInfo}`。

`issue view --json` 返回当前字段以及完整的 `.comments`、`.attachments` 连接（均为 `{nodes,pageInfo}`）；PR 等外部链接可以在 `.attachments.nodes` 的 `url`、`sourceType`、`metadata` 中核对。`--no-comments` 跳过评论读取；变更经过用 `issue history <id> --json`。

只需评论时用 `issue comment list --json`，输出 `{nodes,pageInfo}`；默认最多 50 条，`--limit 0` 读完全部页。例如：

```bash
linear issue comment list ENG-123 --limit 0 --json >comments.json &&
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

需要把新评论交给后续编排时，`linear issue comment add/update` 都加 `--json`；两者的 stdout 都是 `{comment}`，上传进度会写到 stderr。需要核对项目、负责人和状态变更时使用 `linear issue history <id> --json`。

没有正文或附件时，JSON 模式直接报错，不进入交互提示。

## 写后读回

写入不以命令退出码为终点。用结构化读取核对本次修改的字段：

- 专用写命令无 `--json` 时，通过暴露相关字段的 `view` / `list` 读回；都不覆盖时用只读 `linear api` 查询验证。
- 只有人类输出可用时，核对文档化的值并明确说明「结果未经结构化验证」。
- 批量修改前后，把同一完整查询的 JSON 分别保存为快照：先比较排序后的 `.nodes[].identifier` 集合（不能只比数量），再按 identifier 比较本次涉及的目标字段。对新出现的 identifier 单独读取全文，不把旧快照的判断直接套用。

## 时序现实

多步写入前重读目标当前值。基线变化时先保留同事更新并重新判断：在已有授权内能合并的更新计划后继续，目标值或决定冲突的留待确认。`issue apply` 的冲突恢复见 [issue-delivery](issue-delivery.md)。

## 临时脚本编排

一次性审计或异构治理不需要新增一个永久命令。让 CLI 提供认证、结构化读取和 GraphQL 原语；先用 Bash 和 `jq` 组合简单查询，需要保存状态时再用临时 Python / TypeScript 编排。分类、取舍和授权不放进脚本默认值。

## 选择编排语言

| 任务形态                               | 选择                                          | 原因                                 |
| -------------------------------------- | --------------------------------------------- | ------------------------------------ |
| 读取、筛选、计数、格式化报告           | `linear ... --json` 加 `jq`，外面用 Bash 串联 | 无状态，数据只经过一次投影           |
| 一两个已确认的单条修改                 | 直接调用专用 CLI 命令                         | CLI 已负责名称解析和输入校验         |
| 多次读取后生成变更清单，或按目标值分组 | Python / TypeScript                           | 需要保留对象、基线和分组结果         |
| 批量写入、写后核对、未知结果停止       | Python / TypeScript                           | 需要明确处理批次、业务成功和恢复分支 |

不要为了「看起来像自动化」把简单的 `jq` 投影改写成 Python；也不要把 JSON 引号、循环状态和错误分支堆进长 Bash 脚本。脚本变长的原因是业务状态，而不是语言偏好。

推荐固定为这条流水线：

| 阶段 | 做什么                                                                     | 是否写远端 |
| ---- | -------------------------------------------------------------------------- | ---------- |
| 读取 | 用 `doctor` 找问题，再用 `issue query --json` 读取要判断的完整字段         | 否         |
| 计划 | 脚本按标题、现有字段和证据生成表格或 `patch.json`                          | 否         |
| 授权 | 沿用用户已确认的范围与处理原则；只有尚未授权或需要新决定的条目交人确认     | 否         |
| 复核 | 用 `auth whoami --json` 核对 workspace，重读目标并处理基线变化             | 否         |
| 写入 | 已有专用命令的字段逐条调用该命令；只有专用命令未覆盖的长尾操作才用 GraphQL | 是         |
| 验证 | 用同一批目标做一次结构化读回，按 identifier 比较本次字段                   | 否         |

读取示例：

```bash
LINEAR_PROMPT_DISABLED=1 linear doctor self --history --limit 0 --json >doctor.json
LINEAR_PROMPT_DISABLED=1 linear issue query \
  --all-teams --assignee self --limit 0 --json >issues.json
```

查询结果用于发现候选。目标值由用户已有规则和当前证据确定；只读或起草任务到计划为止，治理任务在授权内执行并回读。批量修改 Issue 的边界见 [graphql](graphql.md)。

重复检查时固定 workspace、规则、对象或时间范围。执行前后重跑同一查询，按对象标识比较已消除、仍命中和新增的项。忽略或无需处理的项保留原因及证据，待确认项集中交接；不能将移出范围或忽略算作修复。对象或证据变化后重新判断，旧结果不代替当前事实。

优先让脚本调用专用 CLI 命令，这样名称解析和输入校验仍由 CLI 负责。只有目标 mutation 没有专用命令覆盖时才调用 `linear api`，凭据仍由 CLI 解析，脚本不需要接触 token。只有直接 HTTP 确有必要时，才在进程内通过 `linear auth token` 读取 token；不要把 token 写入文件、日志、`.env` 或命令行参数。

批量写入遇到网络错误、超时或响应无法确认时，停止后续批次，先读回对账；不要把未知结果当成「未写入」再重试。
