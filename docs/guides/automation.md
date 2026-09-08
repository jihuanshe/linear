---
name: automation
description: 无人值守脚本的输出、分页、URL 查重与写后验证
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

## 脚本输入与输出

`--json`、`--no-pager` 不是全局选项，以目标命令的 `--help` 为准。机器处理使用结构化输出，分开 stdout 与 stderr，并检查退出码和所需 JSON 字段：

```bash
NO_COLOR=1 LINEAR_PROMPT_DISABLED=1 linear issue view ENG-123 --json \
  >result.json 2>error.log &&
  jq -e '.identifier == "ENG-123"' result.json >/dev/null
```

`LINEAR_PROMPT_DISABLED=1` 禁用交互；缺少必需输入时命令失败。显式传入 Issue 标识，避免 `issue view` 等命令从当前 Git branch 推断出错误目标。

多行 Markdown 使用 `issue create/update --description-file`、`issue comment add/update --body-file`，避免 shell 转义破坏正文。`document view --raw` 返回未渲染正文，`--json` 同时返回元数据和内容。

人类输出不是稳定协议，`NO_COLOR=1` 不能代替 JSON。专用命令没有结构化输出时，用覆盖目标字段的 `view/list` 或只读 `linear api` 验证；只能核对人类输出时，注明结果未经结构化验证。

## 分页与详情

`issue query --json` 返回 `{nodes,pageInfo}`，`--limit 0` 读完全部页；有限 `--limit` 只读到指定数量。CLI 拼接 `nodes` 并保留连接形状：

```bash
jq -e '.pageInfo.hasNextPage == false and (.nodes | type == "array")' issues.json >/dev/null &&
  jq '.nodes[] | {identifier, title, priority}' issues.json
```

需要完整集合时检查 `hasNextPage`，不能把成功退出或有效 JSON 当成读全。

`issue view --json` 读完 `.comments` 和 `.attachments` 连接；`--no-comments` 跳过评论。PR 等链接可从 `.attachments.nodes` 的 `url`、`sourceType`、`metadata` 核对。其他嵌套集合仍是有限预览，完整读取见 [graphql](graphql.md)。

只读评论用 `issue comment list <id> --limit 0 --json`（默认最多 50 条）；变更经过用 `issue history <id> --json`。评论列表返回 `{nodes,pageInfo}`，评论新增和更新的 JSON 返回 `{comment}`。

## 按 URL 查重

```bash
linear issue query --all-teams --url 'https://example.com/objects/123' --json
linear issue query --all-teams --url-file object-urls.txt --json >url-lookups.json &&
  jq '.lookups[] | {url, identifiers: [.nodes[].identifier]}' url-lookups.json
```

Linear Issue URL 按 identifier 和 workspace 定位；其他 URL 在候选 Issue 正文或评论中核对完整 URL 边界，不搜索侧栏 Attachment。成功响应中的空 `nodes` 只表示当前凭据可见、指定筛选范围内没有命中。

URL 模式读完候选分页并返回全部精确命中，不受有限 `--limit` 截断；`pageInfo` 为 `{hasNextPage:false,endCursor:null}`。`--url` 返回 `{nodes,pageInfo}`；`--url-file` 每行一个 URL，忽略空行和 `#` 注释，去重后按首次出现顺序返回 `{lookups:[{url,nodes,pageInfo}]}`。

## 批量执行与验收

按 [core](core.md) 核对身份和授权，固定 workspace、目标标识与写入范围。简单组合用 Bash 和 `jq`；跨调用保存状态时用临时脚本；多个交付项用 [delivery manifest](issue-delivery.md)。

多步写入前重读目标。基线变化时保留同事更新：授权内可合并的继续处理，决定冲突的留待确认。写入结果未知时停止后续写入并对账，不按「未写入」重试。

用写后的结构化结果逐个核对目标字段。`issue apply --json` 的 `verification` 标明核验结果与范围，具体合同见 [issue-delivery](issue-delivery.md)；`readBack` 保留实际读回内容。已有所需字段时复用结果；只有字段缺失、读回失败或对象再次变化时补读。

验收还要求查询集合变化时，保存前后相同范围的快照，比较标识集合及字段，不能只比数量。新增标识先调查，不自动纳入原写入范围；移出范围不算修复。

健康治理候选用 [doctor](doctor.md) 发现；已知目标直接读取。治理报告区分已修复、仍命中、新增、忽略及待确认项，并保留忽略原因。
