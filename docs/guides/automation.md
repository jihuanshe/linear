---
name: automation
description: 保存原始依据、执行受保护更新并解释 JSON 写入效果与分页
commands:
  - api
  - auth whoami
  - auth token
  - issue view
  - issue export
  - issue history
  - issue query
  - issue create
  - issue update
  - issue comment add
  - issue comment update
  - issue comment view
  - issue comment list
  - issue comment resolve
  - issue comment unresolve
  - project view
  - project update
  - initiative view
  - initiative update
  - document view
  - document update
  - milestone view
  - milestone update
---

# 无人值守执行与写入验证

## 保存讨论开始时的依据

在讨论或编辑前保存原始读取，提交时用 `--base-file` 传回同一份依据。Issue 正文可以直接导出：

```bash
linear issue export ENG-123 --output issue-edit --json
```

导出成功后，阅读 `original.json` 并编辑 `desired.md`，再提交：

```bash
code=0
LINEAR_PROMPT_DISABLED=1 linear issue update ENG-123 \
  --base-file issue-edit/original.json --description-file issue-edit/desired.md --json \
  > issue-edit/result.json 2> issue-edit/result.log || code=$?
jq '{ok, effect, fields, error}' issue-edit/result.json
test "$code" -eq 0
```

`issue export` 不修改 Linear，目标目录必须不存在。读取失败不会创建目录，可以在问题解决后重试同一路径；文件已开始保存后失败则保留现有材料，检查后使用新目录，不覆盖旧依据。导出的 Markdown 不是富文本备份，限制见 `linear guide markdown`。

其他字段可直接保存读取输出，不手抄旧字段。各入口的 JSON 根对象如下；`organization` 均包含稳定 `id` 和 `urlKey`。

| 读取入口                         | 对象路径            | 对应更新入口           |
| -------------------------------- | ------------------- | ---------------------- |
| `issue view <ID> --json`         | `.issue`            | `issue update`         |
| `issue comment view <ID> --json` | `.comment`          | `issue comment update` |
| `project view <ID> --json`       | `.project`          | `project update`       |
| `initiative view <ID> --json`    | `.initiative`       | `initiative update`    |
| `document view <ID> --json`      | `.document`         | `document update`      |
| `milestone view <ID> --json`     | `.projectMilestone` | `milestone update`     |

ID、字段名以及字段是否存在均保留 API 语义：缺字段不同于 `null`、`""`、`0` 或空集合。不同对象或工作区的依据会被拒绝。需要额外条件时，可重复传 `--expect-field`，名称使用该对象支持的 API 响应字段，例如 Issue 的 `state`；不会监控任意查询或整个评论集合。

## 写入安全边界

这里的「安全」只表示 CLI 在自己的边界内拒绝了可识别的错误；它不表示并发安全。Linear API 没有给这些命令提供 CAS、锁或事务，最后一次读取之后仍有竞争窗口。

| 操作                              | CLI 做的保护                                               | 并发结论                                                    |
| --------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| 带 `--base-file` 的字段替换       | 比较对象、工作区、原始值和目标值；冲突时不发 mutation      | 能挡住读取前已经发生的旧依据覆盖；不能挡住最后读取后的竞争  |
| `--unprotected` 字段替换          | 仍检查身份、文件和字段，但跳过原始值比较                   | 明确的覆盖路径；不挡并发覆盖                                |
| 评论、附件和关联创建              | 检查输入；用返回对象确认 ID，并核对返回对象的父对象        | 不是幂等写入；重复调用可能产生重复对象                      |
| 关系创建                          | 检查两端 ID；已有同类型、同方向关系时跳过写入              | 已有关系不会重复创建；不同关系按冲突处理                    |
| resolve／unresolve 和归档状态切换 | 读取当前状态并处理已满足目标的情况；成功保留 mutation 回执 | 预读不是锁；两个执行者可能基于不同状态作出决定              |
| `issue apply`                     | 用 checkpoint 跳过已记录的完成项；`unknown` 会阻止自动续跑 | checkpoint 不是锁；两个执行者仍可能重复派发，部分成功不回滚 |
| `linear api` mutation             | 只要求显式 `--unprotected`，保留原始 GraphQL 响应          | 不提供专用命令的校验、回执或恢复；未知效果由调用者对账      |

`effect: none` 表示本次没有确认的远端写入，`applied` 表示 Linear 已确认 mutation 或部分流程已确认，`unknown` 表示不能判断最终效果。`applied` 不能重发；`unknown` 先按稳定 ID 和回执对账。读回失败不会把已确认写入变成可重试写入。

因此，调用者应把 `--base-file` 当作写前旧值检查，把 `--unprotected` 当作有意覆盖，把评论和附件创建当作可能重复的追加，把 `issue apply` 当作可恢复的顺序执行器，而不是事务系统。

CLI 完成名称解析后，会按同一 UUID 最后读取并比较原始依据。当前值已等于目标值的字段不写；当前值仍等于原始值的字段可写；其余为冲突。一个字段冲突就拒绝整个更新。`--expect-field` 指定的额外依赖也要保持原值，即使目标字段已无需修改。引用按稳定 ID、明确的 ID 集合按集合比较，Markdown 则精确比较字符串。

冲突后保留原始文件，读取当前对象并重新决定如何保留并发修改。重新讨论得到新意图时，保存新的依据与草稿；不要只更新依据文件来消除错误。最后读取之后仍可能发生竞争；该检查不提供服务器 CAS、事务、锁或 ABA 检测。

确实要无保护覆盖时显式使用 `--unprotected`，并移除 `--base-file`；它只跳过旧值比较，身份、文件及领域校验继续执行。Document 的开放行内评论锚点另受 `--force` 保护，两个参数互不代替。交互式编辑会在展示旧值前冻结依据；`--json` 不打开编辑器。

创建、评论追加、侧栏关联和原生标签增删不要求不存在的旧值；Issue 的 `--add-label` / `--remove-label` 使用上游增量操作，不转换为完整集合覆盖。关系新增仍检查是否会替换已有关系。

需要把导出与提交接入自己的脚本时，可修改 `linear recipe guarded-edit`。多项写入的执行进度与恢复见 `linear guide issue-delivery`。

## 机器输出与写入效果

`--json`、`--no-pager` 不是全局选项，以目标命令的 `--help` 为准。显式传入目标编号或 UUID，并使用 `LINEAR_PROMPT_DISABLED=1` 禁用提示。人类输出和 `NO_COLOR=1` 都不能代替机器协议。

专用业务写命令的 `--json` 在 stdout 输出一份 `{ok,effect,data,...}`，可附 `fields`、`verification` 或回执。失败使用 `ok: false` 和 `error`。退出码为零只表示本次调用完整成功；`effect` 单独说明写入效果。`linear api` 是例外：它保留原始 GraphQL 响应，规则见 `linear guide graphql`。

| 写入效果 `effect` | 可据此决定的下一步                                                    |
| ----------------- | --------------------------------------------------------------------- |
| `none`            | 本次没有远端写入，可能是无需修改或写前拒绝；查看 `ok`、字段判定和错误 |
| `applied`         | 写入已得到确认；后续读回或回执处理失败也不能据此重发                  |
| `unknown`         | 无法确认最终效果；停止自动后续写入，按稳定 ID 和已保存回执对账        |

`success: false`、GraphQL 部分错误和不可读结果都不自动证明零效果。复合写入保留已经确认的上传或对象回执；批量删除在 `unknown` 后停止，`unattempted` 列出未执行的对象。

多行 Markdown 用文件参数；`document view --raw` 只输出正文，不能替代带身份的原始读取。原生 `linear api` 保留 GraphQL 响应，属于 `linear guide graphql` 中的明确例外。

## 分页与详情

`issue query --json` 返回 `{nodes,pageInfo}`；`--limit 0` 读到终页，有限的 `--limit` 保留真实后续分页信息。要使用完整集合，检查 `pageInfo.hasNextPage == false`，不能只检查退出码或 JSON 语法。

```bash
linear issue query --all-teams --assignee self --limit 0 --json >issues.json
jq -e '.pageInfo.hasNextPage == false and (.nodes | type == "array")' issues.json >/dev/null
jq '.nodes[] | {id, identifier, title, priority}' issues.json
```

`issue view --json` 完整读取 `.issue.comments`、`.issue.attachments` 和 `.issue.labels`；`--no-comments` 跳过评论。PR 等链接位于 `.issue.attachments.nodes`。`children`、`documents` 和详情中的 `relations` 等集合仍是有限预览；完整关系用 `issue relation list <ID> --json`，其他完整集合按 `linear guide graphql` 单独分页。完整分页不代表跨页数据库快照。

单个 Initiative 或 Project 的短描述与长正文用 `initiative view <ID> --include-content --json` 或 `project view <ID> --include-content --json` 读取。Initiative 的该选项还返回关联 Project 的 `description` 和完整 `documents` 连接；关联文档的正文继续用 `document view` 读取。

需要批量导出当前凭据可见的 Initiative／Project 说明时，可以组合以下查询。它们分别读到终页，保留 `{data: {organization, initiatives|projects: {nodes, pageInfo}}}`，默认不含归档对象：

```bash
linear api 'query ContextInitiatives($after: String) {
  organization { id urlKey }
  initiatives(first: 100, after: $after) {
    nodes { id name url description content }
    pageInfo { hasNextPage endCursor }
  }
}' --paginate > initiatives.json
linear api 'query ContextProjects($after: String) {
  organization { id urlKey }
  projects(first: 100, after: $after) {
    nodes { id name url description content }
    pageInfo { hasNextPage endCursor }
  }
}' --paginate > projects.json
```

两份查询不限定状态；需要选定范围时用当前 schema 的 `filter`，需要归档对象时显式增加 `includeArchived: true`。短描述和 Markdown 正文均不截断；关联文档是独立对象，按需要继续读取。不要把列表命令的默认范围或嵌套关系预览当成完整上下文导出。更新前用对应的 `view --include-content --json` 保存原始依据。Project 和 Initiative 长正文均支持 `update --content-file <path> --base-file <original.json>`；Project 的 `--description-file` 只更新短描述。

例如修改 Project 长正文，先读取并从同一份结果提取草稿，再编辑文件：

```bash
linear project view <ID> --include-content --json > project-original.json
jq -j '.project.content // ""' project-original.json > project-content.md
# 编辑 project-content.md 后提交
linear project update <ID> --content-file project-content.md --base-file project-original.json --json
```

读取成功后才提取草稿；保留 `project-original.json` 原样，不把编辑后的内容写回依据。Markdown 往返的富文本限制同样适用，见 `linear guide markdown`。

单独导出评论用 `issue comment list <ID> --limit 0 --json`；省略 `--limit 0` 时最多读取 50 条，并返回 `{nodes,pageInfo}`。属性变更经过用 `issue history <ID> --json`。

`issue view` 的未解决数量按完整读取后的根线程计算，JSON 保留已解决历史；`--no-comments` 跳过评论，也不显示数量。线程收束见 `linear guide issue-authoring`。`resolve`／`unresolve` 的 JSON 写结果将读回的根评论放在 `.data.comment`；读回失败仍保留已确认的 `effect: applied`。

## 按 URL 查重与复查

```bash
linear issue query --all-teams --url 'https://example.com/objects/123' --json
linear issue query --all-teams --url-file object-urls.txt --json >url-lookups.json
jq '.lookups[] | {url, identifiers: [.nodes[].identifier]}' url-lookups.json
```

Linear Issue URL 按 Issue 编号和工作区定位；其他 URL 核对候选正文或评论中的完整 URL 边界，不搜索侧栏附件（Attachment）。URL 模式完整读取候选并返回全部精确命中，不受 `--limit` 截断；空 `nodes` 只证明当前凭据可见且所选筛选范围内没有命中。`--url-file` 忽略空行与 `#` 注释，去重后按首次出现顺序返回 `lookups`。

比较查询集合时，保存相同范围的前后读取，按 ID 和目标字段核对；新增对象不自动进入原写入范围。按组织规则检查缺项或异常候选时，使用 `linear recipe doctor`，结果解释见 `linear guide doctor`。
