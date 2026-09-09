---
name: automation
description: 保存原始依据、执行受保护更新并解释 JSON 效果与分页
commands:
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
  - issue comment view
  - issue comment list
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

替换字段前先保存原始读取，再讨论或编辑目标内容。六类 replacement 入口共用 `--base-file`；不要收到目标内容后才读取一个新 base 来冒充原始依据。

```bash
# 在新目录中执行；noclobber 防止意外覆盖已有依据。
mkdir issue-edit
cd issue-edit
(set -C; linear issue view ENG-123 --json > original.json)
jq -e '.organization.id and .issue.id and .issue.identifier == "ENG-123"' original.json >/dev/null
# 阅读 original.json 后编写 desired.md。
LINEAR_PROMPT_DISABLED=1 linear issue update ENG-123 \
  --base-file original.json --description-file desired.md --json \
  > result.json 2> result.log
```

直接保存读取输出，不手抄旧字段。各入口的 JSON 根对象如下；`organization` 均包含稳定 `id` 和 `urlKey`。

| 读取入口                         | 对象路径            | 对应更新入口           |
| -------------------------------- | ------------------- | ---------------------- |
| `issue view <ID> --json`         | `.issue`            | `issue update`         |
| `issue comment view <ID> --json` | `.comment`          | `issue comment update` |
| `project view <ID> --json`       | `.project`          | `project update`       |
| `initiative view <ID> --json`    | `.initiative`       | `initiative update`    |
| `document view <ID> --json`      | `.document`         | `document update`      |
| `milestone view <ID> --json`     | `.projectMilestone` | `milestone update`     |

ID、字段名和 presence 保持 API 语义：缺字段不同于 `null`、`""`、`0` 或空集合。不同对象或 workspace 的依据会被拒绝。需要额外条件时，可重复传 `--expect-field`，名称使用该对象支持的 API 响应字段，例如 Issue 的 `state`；不会监控任意查询或整个评论集合。

提交前完成名称解析，再按同一 UUID 最后读取。额外依赖变化时拒绝，即使目标字段已等于 desired。其他字段按精确值判断：current 等于 desired 时不写；current 等于 original 时可写；其余为 conflict。一个对象内存在冲突就不发送该 patch；混合 no-op/write 只提交需要写的字段。引用按稳定 ID、明确的 ID 集合按集合语义比较；Markdown 字符串不做泛化规范化。

冲突后保留原始文件，读取当前对象并重新决定如何保留并发修改。重新讨论得到新意图时，保存新的依据与草稿；不要只刷新 base 来消除错误。同一时刻最后读取之后仍可能发生竞争；该检查不提供服务器 CAS、事务、锁或 ABA 检测。

确实要无保护覆盖时显式使用 `--unprotected`，并移除 `--base-file`；它只跳过旧值比较，身份、文件及领域校验继续执行。Document 的开放行内评论锚点另受 `--force` 保护，两个参数互不代替。交互式编辑会在展示旧值前冻结依据；`--json` 不打开编辑器。

创建、评论追加、侧栏关联和原生标签增删不要求不存在的旧值；Issue 的 `--add-label` / `--remove-label` 使用上游增量操作，不转换为完整集合覆盖。关系新增仍检查是否会替换已有关系。

完整 JS 示例及最小 Python 调用见 [recipes](../../recipes/README.md)。批量执行和自动续跑使用 [issue-delivery](issue-delivery.md) 的唯一账本。

## 机器输出与效果

`--json`、`--no-pager` 不是全局选项，以目标命令的 `--help` 为准。显式传入目标 ID，并使用 `LINEAR_PROMPT_DISABLED=1` 禁用提示。人类输出和 `NO_COLOR=1` 都不能代替机器协议。

业务写命令的 `--json` 在 stdout 输出一份 `{ok,effect,data,...}`，可附 `fields`、`verification` 或回执。失败使用 `ok: false` 和 `error`，即使参数解析或认证失败也遵循此通道。退出码为零只表示本次调用完整成功；`effect` 单独说明写入效果：

| effect    | 可据此决定的下一步                                                   |
| --------- | -------------------------------------------------------------------- |
| `none`    | 本次没有远端写入，可能是 no-op 或写前拒绝；查看 `ok`、字段判定和错误 |
| `applied` | 写入已得到确认；后续读回或回执处理失败也不能据此重发                 |
| `unknown` | 无法确认最终效果；停止自动后续写入，按稳定 ID 和已保存回执对账       |

`success: false`、GraphQL 部分错误和不可读结果都不自动证明零效果。复合写入保留已经确认的上传或对象回执；批量删除在 unknown 后停止，`unattempted` 列出未执行的对象。

```bash
code=0
linear issue update ENG-123 --base-file original.json \
  --description-file desired.md --json >result.json 2>result.log || code=$?
jq '{ok, effect, data, fields, verification, error}' result.json
test "$code" -eq 0 && jq -e '.ok == true' result.json >/dev/null
```

多行 Markdown 用文件参数；`document view --raw` 只输出正文，不能替代带身份的 base。原生 `linear api` 保留 GraphQL envelope，属于 [graphql](graphql.md) 中的明确例外。

## 分页与详情

`issue query --json` 返回 `{nodes,pageInfo}`；`--limit 0` 读到终页，有限 limit 保留真实 continuation。要使用完整集合，检查 `pageInfo.hasNextPage == false`，不能只检查退出码或 JSON 语法。

```bash
linear issue query --all-teams --assignee self --limit 0 --json >issues.json
jq -e '.pageInfo.hasNextPage == false and (.nodes | type == "array")' issues.json >/dev/null
jq '.nodes[] | {id, identifier, title, priority}' issues.json
```

`issue view --json` 完整读取 `.issue.comments`、`.issue.attachments` 和 `.issue.labels`；`--no-comments` 跳过评论。PR 等链接位于 `.issue.attachments.nodes`。children、documents 和详情中的 relations 等集合仍是有限预览；完整关系用 `issue relation list <ID> --json`，其他完整集合按 [graphql](graphql.md) 单独分页。完整分页不代表跨页数据库快照。

只读评论用 `issue comment list <ID> --limit 0 --json`，默认最多 50 条并返回 `{nodes,pageInfo}`；变更经过用 `issue history <ID> --json`。评论追加与更新的写结果对象位于 `.data.comment`。

## 按 URL 查重与复查

```bash
linear issue query --all-teams --url 'https://example.com/objects/123' --json
linear issue query --all-teams --url-file object-urls.txt --json >url-lookups.json
jq '.lookups[] | {url, identifiers: [.nodes[].identifier]}' url-lookups.json
```

Linear Issue URL 按 identifier 和 workspace 定位；其他 URL 核对候选正文或评论中的完整 URL 边界，不搜索侧栏 Attachment。URL 模式完整读取候选并返回全部精确命中，不受 limit 截断；空 nodes 只证明当前凭据可见且所选筛选范围内没有命中。`--url-file` 忽略空行与 `#` 注释，去重后按首次出现顺序返回 lookups。

验收复用实际返回的读回字段。Apply 的 `.data.verification` 标明范围，`.data.readBack` 保存读取内容；缺字段、读回失败或对象再次变化时才补读。需要比较查询集合时，保存相同范围的前后快照，比较 ID 集合与字段；新增对象不自动进入原写入范围。

只读治理候选使用 [doctor recipe](doctor.md)，规则留在可编辑脚本中。报告保留忽略原因与待确认事项，候选数减少不能单独证明修复。
