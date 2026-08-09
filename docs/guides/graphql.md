---
name: graphql
title: Schema discovery and raw GraphQL fallback
description: schema 发现、linear api 变量与 heredoc 用法、查询拆分，以及何时降级到直接 HTTP
keywords:
  - graphql
  - api
  - schema
  - variables
  - fallback
  - pagination
  - 查询
  - 变量
commands:
  - api
  - schema
  - auth token
seeAlso:
  - core
  - automation
---

# Schema 发现与 GraphQL 兜底

`linear api` 是专用命令之外的长尾通道，不是默认路径。CLI 覆盖的操作优先用专用命令：输入校验、冲突保护和结构化输出都在那里。

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

## 拆分查询

大量 Issue 的 description、comments、children 和 relations 不要塞进同一个嵌套查询。先用 `issue query` 读核心字段，逐 Issue 用 `issue view --json` 补正文与评论、`issue relation list` 补关系。收到 `Query too complex` 时减少字段或拆批，不要原样重试。

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
