---
name: graphql
description: schema 发现、精确批量读取、linear api 变量与分页，以及何时降级到直接 HTTP
commands:
  - api
  - schema
  - auth token
---

# Schema 发现与 GraphQL 查询

`linear api` 用于精确字段、少见 filter、跨实体只读查询及专用命令未覆盖的写入。

## 发现 schema

已知字段和输入类型时直接请求；只有字段、类型或参数不确定时，才查询 schema：

```bash
linear schema -o "${TMPDIR:-/tmp}/linear-schema.graphql"
rg -i "cycle" "${TMPDIR:-/tmp}/linear-schema.graphql"
rg -A 30 "^type Issue " "${TMPDIR:-/tmp}/linear-schema.graphql"
```

## 发起请求

查询较长、包含 `$` 或复杂 shell 字符时可用单引号 heredoc；短查询可以内联：

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

`--paginate` 可拼接查询中发现的单个 connection；同一查询包含多个 connection 时拆分查询。项目 Issue 正文查询示例：

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

`--paginate` 读取到 connection 结束；只需样本时省略它，并用 `first` 限定数量。

## 批量修改 Issue

组合多个执行项且字段在 manifest 支持范围内时用 `issue apply`（见 [issue-delivery](issue-delivery.md)）；其他 `issue update` 已支持的操作由脚本逐条调用，编排方式见 [automation](automation.md)。

目标操作未被专用命令覆盖时，按 [core 的入口与授权规则](core.md) 使用 `linear api`：解析目标并校验输入，字段或类型不确定时查 schema，写后核对业务结果和目标字段；结果未知时停止后续写入并对账。

## 拆分查询

`description` 这类标量可以随 Issue connection 批量读取。`issue view --json` 自动读完评论和附件；只需评论可用 `issue comment list <id> --limit 0 --json`，变更经过用 `issue history <id> --json`。children、documents、relations 等其他嵌套集合仍是有上限的详情预览；需要完整集合时，按 Issue 把对应 connection 拆成独立 GraphQL 查询，并用 `--paginate` 读完。不要把多个大集合塞进同一查询；收到 `Query too complex` 时减少字段或拆批，不要原样重试。

## 直接 HTTP

仅在需要完整 HTTP 控制、且 `linear api` 无法满足时使用。脚本应通过受控环境变量或 secret store 提供凭据；不得把 token 放入命令行参数、文件、日志或 shell 历史。使用 `linear api` 无需脚本接触 token。

HTTP 200 不代表 GraphQL 成功：检查 `errors` 为空、`data` 包含目标结果；mutation 还须核对业务 payload 的 `success` 和返回对象。
