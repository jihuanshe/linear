---
name: graphql
description: schema 发现、精确批量读取、linear api 变量与分页，以及何时降级到直接 HTTP
commands:
  - api
  - schema
  - auth token
---

# Schema 发现与 GraphQL 查询

常见领域操作、名称解析和安全写入使用专用命令。精确字段选择、批量正文、少见 filter 和跨实体只读查询直接使用 `linear api`；这些临时读取形状不需要先扩建 typed command。raw mutation 不拥有专用写命令的输入保护与结果核算，仍是没有专用原语时的最后手段。当前 schema 虽然已有 `issueBatchUpdate`，CLI 没有把它做成永久批量命令；一次性脚本可在审批后调用它，规则和流程见 [automation](automation.md)。

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

## 按相同补丁批量更新

`issueBatchUpdate` 的 `ids` 必须是 Issue UUID，不是 `JHS-123` 这样的 identifier；一次最多 50 个 Issue。它把同一个 `IssueUpdateInput` 应用到整批对象，因此先在脚本中按完全相同的目标值分组。名称到 UUID 的解析、审批和写前重读不能省略。

写入前先确认当前凭据对应的 workspace，再执行 mutation：

```bash
LINEAR_PROMPT_DISABLED=1 linear auth whoami --json >whoami.json
jq -e '.organization.urlKey == "expected-workspace"' whoami.json >/dev/null

linear api \
  --variables-json '{"ids":["issue-uuid-1","issue-uuid-2"],"input":{"priority":4,"estimate":1}}' <<'GRAPHQL'
mutation BatchUpdateIssues($ids: [UUID!]!, $input: IssueUpdateInput!) {
  issueBatchUpdate(ids: $ids, input: $input) {
    success
    issues {
      id
      identifier
      priority
      estimate
    }
  }
}
GRAPHQL
```

脚本必须检查 `data.issueBatchUpdate.success` 和返回的 Issue 集合，不能只看 `linear api` 的退出码；GraphQL 的语义失败可能仍然是 HTTP 200。每批写完后，用 [automation](automation.md) 中的完整查询一次读回目标字段。超时、网络错误或结果不完整时停止后续批次并先对账，不自动重试。

## 拆分查询

`description` 这类标量可以随 Issue connection 批量读取；comments、children 和 relations 是嵌套集合，不要把多个大集合塞进同一查询。先读 Issue 标量；需要完整集合时，按 Issue 把每个嵌套 connection 拆成独立 GraphQL 查询，并用 `--paginate` 读完。只需固定边界的详情预览时才使用 `issue view --json` 或 `issue relation list`，这两个命令不保证把嵌套 connection 分页读完。收到 `Query too complex` 时减少字段或拆批，不要原样重试。

## 直接 HTTP

只有需要完整 HTTP 控制时才降级到直接 HTTP。优先在临时 Python / TypeScript 进程中从 `linear auth token` 读取 token 并放入内存中的请求 header；不要把 token 放入命令行参数、文件、日志或 shell 历史。GraphQL 请求必须检查 `data` 存在且 `errors` 为空：

```bash
python3 - <<'PY'
import json
import subprocess
import urllib.request

token = subprocess.run(
    ["linear", "auth", "token"],
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
request = urllib.request.Request(
    "https://api.linear.app/graphql",
    data=json.dumps({"query": "{ viewer { id } }"}).encode(),
    headers={"Content-Type": "application/json", "Authorization": token},
)
with urllib.request.urlopen(request) as response:
    payload = json.load(response)
data = payload.get("data") or {}
viewer = data.get("viewer") or {}
if payload.get("errors") or viewer.get("id") is None:
    raise SystemExit(payload)
print(viewer["id"])
PY
```

这个示例只把查询结果打印到 stdout；mutation 脚本还必须检查业务 payload 的 `success` 和返回对象。GraphQL 的错误可能出现在 HTTP 200 的 `errors` 数组里，不能只看 HTTP 状态码。
