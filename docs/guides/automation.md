---
name: automation
description: 保存原始依据、比较原始值并解释 JSON 写入效果与分页
commands:
  - api
  - auth whoami
  - auth key
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
  - project list
  - project view
  - project update
  - initiative view
  - initiative update
  - document list
  - document view
  - document update
  - milestone view
  - milestone update
---

# 无人值守执行与写入结果

## 保存讨论开始时的依据

在讨论或编辑前保存原始读取，提交时用 `--base-file` 传回同一份依据。Issue 正文可以直接导出：

```bash
linear issue export ENG-123 --output issue-edit --json
```

导出成功后，从 `original.json` 读取当前正文、属性及影响本次编辑的讨论和附件，再编辑 `desired.md` 并提交：

```bash
code=0
LINEAR_PROMPT_DISABLED=1 linear issue update ENG-123 \
  --base-file issue-edit/original.json --description-file issue-edit/desired.md --json \
  > issue-edit/result.json 2> issue-edit/result.log || code=$?
jq '{ok, effect, fields, verification, error}' issue-edit/result.json
test "$code" -eq 0
```

`issue export` 不修改 Linear，目标目录必须不存在。读取失败不会创建目录，可以在问题解决后重试同一路径；文件已开始保存后失败则保留现有材料，检查后使用新目录，不覆盖旧依据。导出的 Markdown 不是富文本备份，限制见 `linear guide markdown`。

其他字段可直接保存读取输出，不手抄旧字段。各入口的 JSON 根对象如下；`organization` 均包含稳定 `id` 和 `urlKey`。

| 读取入口                                | 对象路径            | 对应更新入口           |
| --------------------------------------- | ------------------- | ---------------------- |
| `issue view <issue> --json`             | `.issue`            | `issue update`         |
| `issue comment view <commentId> --json` | `.comment`          | `issue comment update` |
| `project view <project> --json`         | `.project`          | `project update`       |
| `initiative view <initiative> --json`   | `.initiative`       | `initiative update`    |
| `document view <document> --json`       | `.document`         | `document update`      |
| `milestone view <milestone> --json`     | `.projectMilestone` | `milestone update`     |

ID、字段名以及字段是否存在均保留 API 语义：缺字段不同于 `null`、`""`、`0` 或空集合。不同对象或工作区的依据会被拒绝。需要额外条件时，可重复传 `--expect-field`，名称使用该对象支持的 API 响应字段，例如 Issue 的 `state`；不会监控任意查询或整个评论集合。

## CLI 能检查什么

CLI 会检查它能从本地读取和 Linear 返回值中确认的错误。它不能提供远端并发安全：Linear API 没有给这些命令提供条件写入、锁或事务，最后一次读取之后仍有竞争窗口。

- 带 `--base-file` 的字段替换会比较对象、工作区、原始值和目标值。发现冲突时不发 mutation；它只能挡住最后一次读取前已经发生的变化。
- `--unprotected` 字段替换仍检查身份、文件和字段，但跳过原始值比较。它是明确的覆盖路径，不能挡住并发覆盖。
- 普通对象创建会检查引用、`success` 和返回对象的稳定 ID，但没有原始值依据。重复调用可能创建多个对象。
- Issue 的 `--add-label` / `--remove-label` 使用上游增量字段，不把标签集合读回后整体覆盖；它不是通用的并发保证。
- 评论、附件和关联创建会检查返回对象的 ID 和归属，但 CLI 不会去重。重复调用可能创建重复对象。
- 关系创建会检查两端 ID，并在已经读到同类型、同方向关系时跳过写入；两个并发的首次调用仍可能重复创建。
- 删除和归档的预读、确认和成功回执都不是锁，多数路径不做删除后的读回。
- 上传会先捕获并校验本地字节，保存上传回执和已确认的效果；签发上传许可或 PUT 失败不能证明远端效果，不要盲目重传。
- `resolve`／`unresolve` 会读取当前状态，并在已经达到目标时不写入；预读不是锁，两个执行者仍可能基于不同状态作出决定。
- `issue apply` 用执行账本跳过已记录的完成项，`unknown` 阻止自动续跑。同机使用同一账本旁锁文件的执行者互斥；清单副本或其他机器不在保护范围内，部分成功不回滚。锁文件与移交边界见 `linear guide issue-delivery`。
- `linear api` 的 mutation 只要求显式 `--unprotected`，保留原始 GraphQL 响应；它不提供专用命令的校验、回执或恢复，未知效果由调用者对账。

因此，调用者应把 `--base-file` 当作写前原始值比较，把 `--unprotected` 当作无保护更新，把评论和附件创建当作可能重复的追加，把 `issue apply` 当作可恢复的顺序执行器，而不是事务系统。

CLI 完成名称解析后，会按同一 UUID 最后读取并比较原始依据。当前值已等于目标值的字段不写；当前值仍等于原始值的字段可写；其余为冲突。一个字段冲突就拒绝整个更新。`--expect-field` 指定的额外依赖也要保持原值，即使目标字段已无需修改。引用按稳定 ID、明确的 ID 集合按集合比较，Markdown 则精确比较字符串。

冲突后保留原始文件，读取当前对象并重新决定如何保留并发修改。重新讨论得到新意图时，保存新的依据与草稿；不要只更新依据文件来消除错误。最后读取之后仍可能发生竞争；该检查不提供服务器 CAS、事务、锁或 ABA 检测。

确实要无保护覆盖时显式使用 `--unprotected`，并移除 `--base-file`；它只跳过旧值比较，身份、文件及领域校验继续执行。Document 的开放行内评论锚点保护需用 `document update --force` 显式绕过，不能用 `--unprotected` 代替。交互式编辑会在展示旧值前冻结依据；`--json` 不打开编辑器。

创建、评论追加、侧栏关联和原生标签增删不要求不存在的旧值；Issue 的 `--add-label` / `--remove-label` 使用上游增量操作，不转换为完整集合覆盖。关系新增仍检查是否会替换已有关系。

给 Issue 加侧栏文件用 `issue attach`；新建带文件评论用 `issue comment add --attach`；给已有评论补文件时，先保存 `issue comment view --json`，再用 `issue comment update <commentId> --base-file comment-original.json --attach <path>`，其中 `comment-original.json` 是保存的原始读取。三种路径的完整示例与上传后冲突恢复见 `linear guide issue-authoring`。多项写入的执行进度与恢复见 `linear guide issue-delivery`。

## 机器输出与写入效果

`--json`（`-j`）可放在命令路径前、中、后，含义相同，例如 `linear --json issue view ENG-123` 与 `linear issue view ENG-123 --json`。根和领域导航也支持 JSON；`usage --json` 的 `outputModes` 描述各命令是否提供机器结果。未支持的命令在执行前返回 `UnsupportedOutputError`，不输出人类文本或代为执行其他命令。

JSON 不与浏览器／应用跳转、显式交互／编辑或原文／脚本输出组合。`--json --help`、`--json --version` 同样被拒绝；命令元数据用 `usage --json`，构建身份用 `version --json`。`schema --json --output <path>` 保存 JSON 文件，成功时 stdout 留空。

`--no-pager` 仍是命令级选项。自动化显式传入目标编号或 UUID，并使用 `LINEAR_PROMPT_DISABLED=1` 禁用提示；JSON 不代替删除确认或写入授权。人类输出和 `NO_COLOR=1` 都不能代替机器协议。

专用业务写命令的 `--json` 在 stdout 输出一份 `{ok,effect,data,...}`，可附 `fields`、`verification` 或回执。失败使用 `ok: false` 和 `error`。退出码为零只表示本次调用完整成功；`effect` 单独说明写入效果。`linear api` 是例外：它保留原始 GraphQL 响应，规则见 `linear guide graphql`。

创建单个实体时，`data` 下保留 GraphQL 资源字段，而不是把字段直接展开到 `data`；例如 Issue 编号在 `data.issue.identifier`，Document ID 在 `data.document.id`。具体路径见创建命令的 `--json` 帮助。删除、批量操作、上传与原生 API 各自保留其合同。

| 写入效果 `effect` | 可据此决定的下一步                                                    |
| ----------------- | --------------------------------------------------------------------- |
| `none`            | 本次没有远端写入，可能是无需修改或写前拒绝；查看 `ok`、字段判定和错误 |
| `applied`         | 写入已得到确认；后续读回或回执处理失败也不能据此重发                  |
| `unknown`         | 无法确认最终效果；停止自动后续写入，按稳定 ID 和已保存回执对账        |

`success: false`、GraphQL 部分错误和不可读结果都不自动证明零效果。复合写入保留已经确认的上传或对象回执；批量删除在 `unknown` 后停止，`unattempted` 列出未执行的对象。

多行 Markdown 用文件参数；`document view --raw` 只输出正文，不能替代带身份的原始读取。原生 `linear api` 保留 GraphQL 响应，属于 `linear guide graphql` 中的明确例外。

`issue update` 在 mutation 确认后读取相同 Issue 和工作区，核对请求的字段及标签增删结果；仅在读到不同值时重读，最多读取 3 次，总时限 10 秒。身份、权限、结构等导致的不可用结果直接报告。正文沿用 `issue apply` 的 Markdown 结构比较，写前原始依据仍精确比较。成功结果的 `verification.status` 为 `verified`，`readBack` 保存 `{organization,issue}`；无需写入时沿用提交前的读取，不另做写后核验。

读回不匹配或不可用时，命令以非零退出，保留 `effect: applied` 与 `data` 中的 mutation 回执；`error.details.verification.status` 为 `different` 或 `unavailable`。此时只补充读取和对账，不重发 mutation。这个读回不验证评论、附件或更晚发生的并发修改。

## 网络等待与查询重试

专用命令与 `linear api` 共用 GraphQL 请求规则：每个逻辑请求最多 60 秒，包含响应正文读取和重试等待，query 最多尝试 3 次。分页的每一页分别计时，不是整个命令或整批 `apply` 的总时限；写后核验等调用方更短的取消期限仍然有效。此规则不涵盖文件 PUT、下载或其他非 GraphQL 网络操作。

只有明确选中的 query 会对 HTTP 429／502／503／504，以及 HTTP 200／400 中单纯的 `RATELIMITED` 错误重试。无完整响应的连接错误、已有部分数据、认证、权限和校验错误不重试。等待使用有界退避，并遵守 `Retry-After` 的秒数或 HTTP 日期；剩余时间不足以遵守服务器要求时，返回原始失败，不缩短等待后强行重试。

mutation 不自动重发。派发后的超时、连接或响应读取失败仍可能已经写入，按 `effect` 与回执对账，不把超时理解为撤销。

## 分页与详情

`issue query --json` 返回 `{nodes,pageInfo}`；`--limit 0` 读到终页，有限的 `--limit` 保留真实后续分页信息。要使用完整集合，检查 `pageInfo.hasNextPage == false`，不能只检查退出码或 JSON 语法。

```bash
linear issue query --all-teams --assignee self --limit 0 --json >issues.json
jq -e '.pageInfo.hasNextPage == false and (.nodes | type == "array")' issues.json >/dev/null
jq '.nodes[] | {id, identifier, title, priority}' issues.json
```

`issue view --json` 与 `issue export` 完整读取 `.issue.comments`、`.issue.attachments` 和 `.issue.labels`；`view --no-comments` 跳过评论。评论保留 `quotedText` 和 `documentContentId`，供识别行内引用；PR 等链接位于 `.issue.attachments.nodes`。`children`、`documents` 和详情中的 `relations` 等集合仍是有限预览；完整关系用 `issue relation list <issue> --json`，其他完整集合按 `linear guide graphql` 单独分页。完整分页不代表跨页数据库快照。

单个 Initiative 或 Project 的短描述与长正文用 `initiative view <initiative> --json` 或 `project view <project> --json` 读取。Initiative 还返回关联 Project 的 `description` 和完整 `documents` 连接；关联文档的正文继续用 `document view` 读取。

需要批量导出当前凭据可见的 Initiative 说明时，以下查询读到终页，保留 `{data: {organization, initiatives: {nodes, pageInfo}}}`，默认不含归档对象：

```bash
linear api 'query ContextInitiatives($after: String) {
  organization { id urlKey }
  initiatives(first: 100, after: $after) {
    nodes { id name url description content }
    pageInfo { hasNextPage endCursor }
  }
}' --paginate > initiatives.json
```

### 工作区项目上下文

先按 `linear guide core` 核对工作区身份。下面的查询不按默认团队或状态筛选，读取当前凭据可见的全部未归档项目，保留 `{data: {organization, projects: {nodes, pageInfo}}}`。`description` 是短简介；Overview 页中 Description 区的长正文是 `content`，两者均不截断。主要属性和所属 Initiative 随项目读取，Resources 只取文档、外链和附件的目录，不展开其正文或访问链接。

`linear project list` 默认按已配置的团队筛选，即使使用 `--all-teams` 也不返回项目正文或资源目录；`linear document list` 只读取一页。不要用这两个列表代替下面的完整上下文导出。

```bash
linear api 'query ContextProjects($after: String) {
  organization { id urlKey }
  projects(first: 25, after: $after) {
    nodes {
      id name url description content archivedAt trashed
      status { name type }
      lead { id name }
      priority startDate targetDate
      teams(first: 20) {
        nodes { id key name }
        pageInfo { hasNextPage endCursor }
      }
      labels(first: 20) {
        nodes { id name }
        pageInfo { hasNextPage endCursor }
      }
      initiatives(first: 10) {
        nodes { id name url }
        pageInfo { hasNextPage endCursor }
      }
      documents(first: 10) {
        nodes { id title url updatedAt }
        pageInfo { hasNextPage endCursor }
      }
      externalLinks(first: 10) {
        nodes { id label url }
        pageInfo { hasNextPage endCursor }
      }
      attachments(first: 10) {
        nodes { id title subtitle url }
        pageInfo { hasNextPage endCursor }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}' --paginate > projects.json
```

命令成功后检查外层及每个内层连接。`--paginate` 只补齐 `projects`，不会递归补齐资源目录：

```bash
jq -e '
  ((.errors // []) | length == 0) and
  (.data.projects.nodes | type == "array") and
  (.data.projects.pageInfo.hasNextPage == false) and
  all(.data.projects.nodes[];
    all(.teams, .labels, .initiatives, .documents, .externalLinks, .attachments;
      (.nodes | type == "array") and .pageInfo.hasNextPage == false))
' projects.json >/dev/null
```

检查失败时，先区分请求错误、字段缺失和内层分页未结束，不能把结果当成完整目录。内层仍有下一页时，按项目 UUID 单独分页读取该集合；例如补齐某个项目的文档目录，先将它的 UUID 赋给 `PROJECT_ID`：

```bash
linear api 'query ProjectDocuments($id: String!, $after: String) {
  organization { id urlKey }
  project(id: $id) {
    id
    documents(first: 100, after: $after) {
      nodes { id title url updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}' --variables-json "{\"id\":\"$PROJECT_ID\"}" --paginate > project-documents.json
```

核对返回的工作区、项目 ID、`errors` 和 `.data.project.documents.pageInfo.hasNextPage == false`，用这份完整目录取代该项目原来的文档预览，不把两份节点直接拼接。其他内层集合按相同方式每次单独分页一个连接；团队也可直接用 `linear project teams <project> --json` 读全，但结果含归档团队，范围比上面的预览更大。完整分页不保证跨页快照一致。

只有成功读到终页且 `nodes` 为空，才能说「没有资源」；有条目但未载入正文是「有资料、内容未读」；分页未结束、请求失败或权限不足都不能解释成空目录。目录中的文档通过 `linear document view <document-id> --json` 继续读取；外部链接按任务需要访问，不能仅凭标题推断内容。上述项目与资源范围均限于当前凭据可见内容，不能证明无权访问的资料不存在。

先完整阅读全部项目说明和资源目录，再按 `linear guide issue-authoring` 判断归属与补读材料。保存 JSON 后可分块阅读；不要因终端截断而省略剩余项目，也不必把全部文档、历史 Issue、评论或外部页面一起展开。需要历史背景时，在对应集合显式增加 `includeArchived: true`；保留状态与归档标识，不把历史项目当成当前承接方。

### 更新项目正文

上下文导出不替代受保护写入的原始依据。更新前用对应的 `view --json` 保存原始依据。Project 和 Initiative 长正文均支持 `update --content-file <path> --base-file original.json`，其中 `original.json` 是对应对象的原始读取；Project 的 `--description-file` 只更新短描述。

例如修改 Project 长正文，先读取并从同一份结果提取草稿，再编辑文件：

```bash
linear project view <project> --json > project-original.json
jq -j '.project.content // ""' project-original.json > project-content.md
# 编辑 project-content.md 后提交
linear project update <project> --content-file project-content.md --base-file project-original.json --json
```

读取成功后才提取草稿；保留 `project-original.json` 原样，不把编辑后的内容写回依据。Markdown 往返的富文本限制同样适用，见 `linear guide markdown`。

### 评论与历史

单独导出评论用 `issue comment list <issue> --limit 0 --json`；省略 `--limit 0` 时最多读取 50 条，并返回 `{nodes,pageInfo}`。属性变更经过用 `issue history <issue> --json`，默认读取全部历史页，也返回 `{nodes,pageInfo}`；使用有限 `--limit` 时检查后续游标。

`history` 展示上游返回的活动记录，不保证每次写入都有独立条目。Kadoraba 实测中，紧接创建的部分标题／正文修改未出现，后续优先级和附件变更有记录；原生 GraphQL 返回相同结果，具体原因未确定。用 `view` 读取当前状态；判断写入是否发生要结合本次回执与读回，不能因历史缺项重发写入。

`issue view` 的未解决数量按完整读取后的根线程计算，JSON 保留已解决历史；`--no-comments` 跳过评论，也不显示数量。线程收束见 `linear guide issue-authoring`。`resolve`／`unresolve` 的 JSON 写结果将读回的根评论放在 `.data.comment`；读回失败仍保留已确认的 `effect: applied`。

## 按 URL 查重与复查

```bash
linear issue query --all-teams --url 'https://example.com/objects/123' --json
linear issue query --all-teams --url-file object-urls.txt --json >url-lookups.json
jq '.lookups[] | {url, identifiers: [.nodes[].identifier]}' url-lookups.json
```

Linear Issue URL 按 Issue 编号和工作区定位；其他 URL 核对候选正文或评论中的完整 URL 边界，不搜索侧栏附件（Attachment）。URL 模式完整读取候选并返回全部精确命中，不受 `--limit` 截断；空 `nodes` 只证明当前凭据可见且所选筛选范围内没有命中。`--url-file` 忽略空行与 `#` 注释，去重后按首次出现顺序返回 `lookups`。

比较查询集合时，保存相同范围的前后读取，按 ID 和目标字段核对；新增对象不自动进入原写入范围。按组织规则检查缺项或异常候选时，使用 `linear recipe doctor`，结果解释见 `linear guide doctor`。
