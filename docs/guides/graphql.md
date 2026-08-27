---
name: graphql
description: schema 发现、精确批量读取、linear api 变量与分页，以及何时降级到直接 HTTP
commands:
  - api
  - schema
  - auth token
---

# Schema 发现与 GraphQL 查询

常见领域操作、名称解析和安全写入使用专用命令。精确字段选择、批量正文、少见 filter 和跨实体只读查询直接使用 `linear api`；这些临时读取形状不需要先扩建 typed command。raw mutation 不拥有专用写命令的输入保护与结果核算，仍是没有专用原语时的最后手段。

## 发现 schema

把 schema 写到临时文件再搜索，不要凭记忆猜字段：

```bash
linear schema -o "${TMPDIR:-/tmp}/linear-schema.graphql"
rg -i "cycle" "${TMPDIR:-/tmp}/linear-schema.graphql"
rg -A 30 "^type Issue " "${TMPDIR:-/tmp}/linear-schema.graphql"
```

## 发起请求

含非空类型标记（`String!` 这类）的查询用 heredoc 传入，避免 shell 转义问题；无标记的简单查询可以内联：

```bash
# 简单查询
linear api '{ viewer { id name email } }'

# 变量 + heredoc
linear api --variable teamId=abc123 <<'GRAPHQL'
query($teamId: String!) { team(id: $teamId) { name } }
GRAPHQL

# 复杂变量走 JSON
linear api --variables-json '{"filter": {"state": {"name": {"eq": "In Progress"}}}}' <<'GRAPHQL'
query($filter: IssueFilter!) { issues(filter: $filter) { nodes { title } } }
GRAPHQL

# 校验后再消费
linear api '{ issues(first: 5) { nodes { identifier title } } }' \
  >api-result.json 2>api-error.log &&
  jq -e '.data.issues.nodes | map(.title)' api-result.json
```

`linear api` 在 stdout 不是 TTY 时输出 JSON。响应保留 GraphQL 字段名、嵌套和连接形状（`nodes` / `pageInfo`），不做扁平化或重命名。

## 精确批量读取

只选择当前判断需要的字段。以下查询一次读取项目 Issue 的 identifier、state、title 与 description；响应只有一个顶层 connection，可以由 `--paginate` 安全拼接各页：

```bash
linear api \
  --paginate \
  --variables-json '{"filter":{"team":{"key":{"eq":"JHS"}},"project":{"name":{"eq":"Pro｜卡组功能｜游戏王"}}}}' <<'GRAPHQL'
query ProjectIssueContext($filter: IssueFilter!, $after: String) {
  issues(filter: $filter, first: 100, after: $after) {
    nodes {
      identifier
      state { name type }
      title
      description
    }
    pageInfo { hasNextPage endCursor }
  }
}
GRAPHQL
```

`--paginate` 会读取到 connection 结束，只在确实需要完整集合时使用；只需样本时省略该 flag，并把 `first` 设为明确上限。字段投影、分组和重排继续用 `jq`、Python 或调用宿主，不在 CLI 内重造查询语言。

## 拆分查询

`description` 这类标量可以随 Issue connection 批量读取；comments、children 和 relations 是嵌套集合，不要把多个大集合塞进同一查询。先读 Issue 标量；需要完整集合时，按 Issue 把每个嵌套 connection 拆成独立 GraphQL 查询，并用 `--paginate` 读完。只需固定边界的详情预览时才使用 `issue view --json` 或 `issue relation list`，这两个命令不保证把嵌套 connection 分页读完。收到 `Query too complex` 时减少字段或拆批，不要原样重试。

## 直接 HTTP

只有需要完整 HTTP 控制时才降级到 curl：

```bash
curl -fsS -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $(linear auth token)" \
  -d '{"query": "{ viewer { id } }"}' \
  >api-result.json 2>api-error.log &&
  jq -e '.data.viewer.id and ((.errors // []) | length == 0)' api-result.json >/dev/null
```

GraphQL 的错误可能出现在 HTTP 200 的 `errors` 数组里；校验 `data` 存在且 `errors` 为空，不能只看 HTTP 状态码。
