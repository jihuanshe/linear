---
name: graphql
description: 查询 schema、传递变量、完整分页与拆分复杂查询
commands:
  - api
  - schema
  - auth token
---

# Schema 与 GraphQL 查询

`linear api` 用于精确字段、少见筛选、跨实体查询及专用命令未覆盖的写入；入口与授权边界见 [core](core.md)。

## Schema 与变量

字段或参数不确定时查询 schema，已知类型时直接请求：

```bash
linear schema -o "${TMPDIR:-/tmp}/linear-schema.graphql"
rg -A 30 '^type Issue ' "${TMPDIR:-/tmp}/linear-schema.graphql"
```

含 `$` 或多行查询使用单引号 heredoc，避免 shell 展开。简单变量用 `--variable`，对象或数组用 `--variables-json`：

```bash
linear api --variable teamId=abc123 <<'GRAPHQL'
query($teamId: String!) { team(id: $teamId) { name } }
GRAPHQL
```

`linear api` 在 stdout 非 TTY 时输出 JSON，保留 `{data,errors}` 响应及嵌套字段。检查退出码和目标字段；HTTP 200 仍可包含部分失败，不能忽略 `errors`。见 [Linear 错误处理](https://linear.app/developers/graphql#error-handling)。

## 完整分页

`--paginate` 只处理一个 connection。查询必须声明 `$after: String`，把它传给该 connection，并返回 `nodes` 与 `pageInfo { hasNextPage endCursor }`：

```bash
linear api --paginate \
  --variables-json '{"filter":{"team":{"key":{"eq":"ENG"}},"project":{"name":{"eq":"Example project"}}}}' \
  >issues.json 2>issues.log <<'GRAPHQL'
query ProjectIssues($filter: IssueFilter!, $after: String) {
  issues(filter: $filter, first: 100, after: $after) {
    nodes {
      identifier
      title
      description
      state { name type }
    }
    pageInfo { hasNextPage endCursor }
  }
}
GRAPHQL
```

命令成功后核对完整性再消费：

```bash
jq -e '((.errors // []) | length == 0) and (.data.issues.nodes | type == "array") and (.data.issues.pageInfo.hasNextPage == false)' issues.json >/dev/null &&
  jq '.data.issues.nodes[] | {identifier, title}' issues.json
```

结果在原 connection 中拼接 `nodes`，保留最后一页的 `pageInfo`。只需样本时省略 `--paginate`，用 `first` 限量。服务端分页约定见 [Linear 分页文档](https://linear.app/developers/pagination)。

查询可以包含嵌套 connection，但 `--paginate` 只推进外层 connection 的游标，不补齐其节点中的嵌套集合。即使命令成功且外层 `hasNextPage` 为 `false`，内层仍可能有后续页；需要完整内层集合时，按父对象单独查询并分页。

## 拆分查询

`description` 等标量可以随 Issue 列表批量读取。评论、附件和历史优先用专用入口，见 [automation](automation.md)。`issue view --json` 中的 children、documents、relations 等其他集合仍是有限预览；需要完整集合时，按 Issue 拆成独立 connection 查询并分页。

不要把多个需要完整读取的集合交给同一 `--paginate` 查询；多个独立 connection 会被拒绝，嵌套 connection 则保留服务端返回的有限内容。收到 `Query too complex` 时减少字段或拆批，不原样重试。

## 未覆盖的写入与直接 HTTP

组合多个执行项且均在 manifest 支持范围内时，用 [issue-delivery](issue-delivery.md)；其他已支持的操作用专用命令逐条执行。只有未覆盖的写入才用 `linear api`，写后核对 mutation 的业务结果（如 `success`、返回对象）和目标字段；结果未知时按 [automation](automation.md) 对账。

仅在 `linear api` 无法提供所需 HTTP 控制时直接请求。凭据由进程环境或 secret store 注入，不进入命令参数、文件或日志；`auth token` 会输出密钥，只能在受控进程内消费。
