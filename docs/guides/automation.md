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
- 机器输出使用 `--json` 和 `NO_COLOR=1`，stdout 与 stderr 分开，退出码和 JSON 均须有效：

```bash
NO_COLOR=1 linear issue view ENG-123 --json >result.json 2>error.log &&
  jq -e . result.json >/dev/null
```

- 人类输出不是稳定协议。必须解析时，剥离 ANSI 并只取文档化的值；`NO_COLOR=1` 不能代替结构化输出。
- 读取 document 正文用 `document view --raw` 绕过终端 Markdown 渲染；需要元数据加内容的结构化信封时用 `--json`。
- 交互提示在无人值守环境用 `LINEAR_PROMPT_DISABLED=1` 禁用；提示被禁用后缺输入的命令会失败而不是挂起。禁用提示不代表获得写入授权。
- 后续命令显式传 Issue 标识。`issue view` 等命令省略参数时会从当前 Git branch 推断目标，无人值守脚本在仓库 checkout 里可能因此打到错误的 Issue。

## 分页形状

`issue query --json` 返回 `{nodes,pageInfo}`。`--limit` 超过单页大小或传 `0`（不设上限）时，CLI 自动翻页并拼接 `nodes`，保留连接形状：

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

只需评论时用 `issue comment list --json`，输出 `{nodes,pageInfo}`；默认最多 50 条，`--limit 0` 读完全部页。

## Markdown 走文件 flag

多行 Markdown 用文件 flag：`issue create/update --description-file`、`issue comment add/update --body-file`。内联 `--description`、`--body` 只用于单行，避免 shell 转义破坏正文。

`issue comment add/update --json` 返回 `{comment}`，上传进度写 stderr；没有正文或附件时直接报错，不进入交互提示。

## 写后读回

写入不以命令退出码为终点。用本次写后的结构化读回核对修改的字段；`issue apply --json` 已返回 `verification` 和 `readBack`，优先使用它们（见 [issue-delivery](issue-delivery.md)）。已有完整结果时不重复查询；缺少所需字段、读回失败或有证据表明对象再次变化时才补充读取：

- 专用写命令无 `--json` 时，通过暴露相关字段的 `view` / `list` 读回；都不覆盖时用只读 `linear api` 查询验证。
- 只有人类输出可用时，核对文档化的值并明确说明「结果未经结构化验证」。
- 固定目标的批量修改：逐个 identifier 核对本次修改的字段是否达到目标值，复用已有写后读回，不以命中数量或集合不变证明字段修改成功。
- 验收另有查询命中集合要求时：保存修改前后同一范围的查询快照，比较排序后的 `.nodes[].identifier` 集合，不能只比数量。字段验证仍复用已有读回；新出现的 identifier 先读取所需证据并重新判断，不自动纳入原写入范围。

## 时序现实

多步写入前重读目标当前值。基线变化时先保留同事更新并重新判断：在已有授权内能合并的更新计划后继续，目标值或决定冲突的留待确认。`issue apply` 的冲突恢复见 [issue-delivery](issue-delivery.md)。

## 批量编排

简单查询用 Bash 和 `jq`；需要跨调用保存状态时用临时 Python / TypeScript。多个执行项可用 [delivery manifest](issue-delivery.md)。专用命令与 GraphQL 的选择见 [graphql](graphql.md)，无需为一次性任务新增 CLI 命令。

批次固定 workspace、目标和写入范围，用 `auth whoami --json` 核对身份。已有授权内连续执行；输入分歧集中报告，认证或 workspace 不一致时停止相关批次，写入结果未知时先对账，不能按「未写入」重试。只读或起草请求不授权写入。

仅需发现健康治理候选时使用 [doctor](doctor.md)；已知目标直接读取所需字段，不扩大扫描。治理结果按相同范围报告已修复、仍命中、新增、忽略及待确认项；忽略项保留原因，移出范围不算修复。
