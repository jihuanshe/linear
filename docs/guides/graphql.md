---
name: graphql
description: 查询 GraphQL schema、传递变量、完整分页与拆分复杂查询
commands:
  - api
  - schema
  - auth token
---

# GraphQL schema 与查询

`linear api` 用于精确字段、少见筛选、跨实体查询及专用命令未覆盖的写入；入口与授权边界见 `linear guide core`。

## 查询字段与传入变量

字段或参数不确定时查询 GraphQL schema，已知类型时直接请求：

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

请求前的本地拒绝或没有可读 GraphQL 结果时，stdout 使用 CLI 的 `{ok:false,effect,error}` 错误结果。原生 mutation 的不可读结果标记为 `unknown`；上游正常返回的 GraphQL 响应保持原样。

一个 GraphQL 文档包含多个操作时必须用 `--operation-name` 选择；命令按语法树辨认实际选中的 query 或 mutation，不根据字符串猜测。名称缺失、重复或含糊都在请求前失败。

## 完整分页

`--paginate` 只处理 query 的一个分页连接（connection）。查询必须声明 `$after: String`，把它作为 `after: $after` 传给该连接，并返回 `nodes` 与 `pageInfo { hasNextPage endCursor }`。命令从第一页开始；显式非空 `after` 和 mutation 都在请求前被拒绝：

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

结果在原分页连接中拼接 `nodes`，保留最后一页的 `pageInfo`。只需样本时省略 `--paginate`，用 `first` 限量。服务端分页约定见 [Linear 分页文档](https://linear.app/developers/pagination)。

缺失或循环游标、连接路径改变、响应结构不完整和后续页读取失败都会非零退出，不输出已经累积的节点。上游返回 GraphQL `errors` 时保留该页的原始响应，绝不拼入之前的页冒充完整成功。完整分页只表示读到了终页，不保证所有页来自同一时刻。

查询可以包含嵌套分页连接，但 `--paginate` 只推进外层连接的游标，不补齐其节点中的嵌套集合。即使命令成功且外层 `hasNextPage` 为 `false`，内层仍可能有后续页；需要完整内层集合时，按父对象单独查询并分页。

## 拆分查询

`description` 等标量可以随 Issue 列表批量读取。评论、附件和历史优先用专用入口，见 `linear guide automation`。`issue view --json` 的 `.issue.children`、`.issue.documents` 和详情中的 `relations` 等集合仍是有限预览；完整关系使用 `issue relation list <ID> --json`，其他集合按 Issue 拆成独立分页连接查询。

不要把多个需要完整读取的集合交给同一 `--paginate` 查询；多个独立分页连接会被拒绝，嵌套连接则保留服务端返回的有限内容。收到 `Query too complex` 时减少字段或拆批，不原样重试。

## 未覆盖的写入与直接 HTTP

组合多个执行项且均在交付清单支持范围内时，用 `linear guide issue-delivery`；其他已支持的操作用专用命令逐条执行。只有未覆盖的写入才用 `linear api --unprotected`。这个显式参数只放行原生 mutation，不提供专用命令的领域校验、依据比较、回执或执行账本；任意 mutation 不映射成另一份领域命令目录。

原生请求不会自动重试，包括 HTTP 200 或 HTTP 400 中的 `RATELIMITED`。GraphQL 响应在两种 HTTP 状态下都保留在 stdout，错误以非零退出码表示。写后核对 mutation 的业务结果（如 `success`、返回对象）和目标字段；GraphQL 部分错误或结果无法读取并不证明零写入，结果未知时按 `linear guide automation` 对账后再决定是否重试。

仅在 `linear api` 无法提供所需 HTTP 控制时直接请求。凭据由进程环境或密钥存储注入，不进入命令参数、文件或日志；`auth token` 会输出密钥，只能在受控进程内消费。
