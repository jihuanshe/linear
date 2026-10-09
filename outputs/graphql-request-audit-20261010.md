# GraphQL 升级与请求数量巡查

核对时间：2026 年 10 月 10 日（Asia/Shanghai）。

本次同步了 Linear 实时公开 schema，并重新生成类型。相对仓库 2026 年 9 月 28 日的 schema，新增 7 个类型、26 个已有类型字段、5 个枚举值和 1 个可选参数；没有破坏性 schema 变更。新增公开能力主要是工作区资源配额、Team 加入／退出权限和当前用户的 Team Membership。它们没有直接替代现有 CLI 的请求。Origin 集成和子文档字段多标注为 Internal，未接入命令。

GraphQL 核心 `17.0.2`、`graphql-request 7.4.0`、TypedDocumentNode `3.2.0` 已是 npm 的最新稳定版。Codegen CLI 已从 `7.4.3` 升至 `7.4.6`，client preset 从 `6.2.0` 升至 `6.2.3`。Codegen 作用于构建和类型生成，不会自动合并运行时请求。核心和请求客户端的最新发布说明没有列出自动减少请求的能力。

## 请求数实测与可实施的改进

以下实测使用生产 `src/main.ts` 入口和仓库现有 MockLinearServer。只验证 CLI 的派发数量，没有向真实 Linear 工作区写入。候选数是根据当前查询结构推导的目标，尚未实施，也未用真实工作区验证。

| 场景                                                                     | 当前实测 | 候选目标   | 改进                                                                          |
| ------------------------------------------------------------------------ | -------- | ---------- | ----------------------------------------------------------------------------- |
| 非交互创建 Issue，`--state default`，不自动指派自己，无其他关联选项      | 4 次     | 2 次       | 将 Team 身份、workflow states 和默认状态合并到一次查询，保留一次创建 mutation |
| 用 Issue 标识符执行 `view`，所有嵌套连接只有一页                         | 1 次     | 已合并     | Issue、viewer、organization、评论、附件及上下文均在首个请求内                 |
| 用 canonical Linear URL 执行同一 `view`                                  | 2 次     | 1 次       | 复用详情查询返回的 organization 校验 URL 工作区，保留跨工作区拒绝行为         |
| `apply` 创建一个 Issue 并添加 10 条评论                                  | 24 次    | 14 次      | 将 Issue 读回与 10 条评论回执组成一个有别名的查询；11 次 mutation 保持原样    |
| `query --id` 读取 100 个当前标识符，标签和 incoming relations 不需要续页 | 1 次     | 已批量读取 | 当前按 100 个标识符分组，先过滤读取；旧标识符和缺失项另行对账                 |

创建前的合并 Team 查询，以及含 Issue、评论、附件、关系回执的合并读回查询，均已通过升级前和升级后 schema 的 GraphQL 文档校验。因此这些节省来自对现有 API 的用法，并非此次新增能力。分页、歧义判断、缺失对象错误、取消期限和读回失败仍需实现时验证。

## 批量能力与约束

`issueBatchCreate` 和 `issueBatchUpdate` 在旧 schema 中已经存在，本次没有新增或增强。schema 描述创建最多 50 个 Issue，且创建是原子的；更新最多 50 个 UUID，所有对象共享同一份 `IssueUpdateInput`。因此 50 次创建 mutation 或相同字段的更新 mutation 可以按接口形状压缩为 1 次，但不能把它直接解释为完整 `apply` 的请求数降低 50 倍。

当前 `apply` 按执行项记录派发前的 unknown、取得回执后的 completed，以及最终读回。若接入批量写入，需要同步设计整批 unknown、回执对应关系、部分失败和恢复；schema 没有证明批量更新的完整原子性。未进行真实 mutation 实验，也未改写恢复语义。

2026 年 10 月 10 日向 Linear 公开端点发送无凭据的 introspection 请求：单个 operation 返回 HTTP 200；两个 operation 组成的 HTTP JSON 数组返回 HTTP 400，错误为 `Operation batching disabled.`。因此不能靠 `graphql-request.batchRequests()` 合并 HTTP 请求。GraphQL 单个 query 内的多字段和 aliases 是另一种方式，当前名称候选解析和旧 Issue 标识符解析已使用它。

Linear 同时限制请求次数和查询复杂度。官方文档给出的单查询复杂度上限是 10,000；连接的 `first` 会乘上子字段成本。现有批量 Issue 查询包含嵌套连接，不适合统一把页大小提高到 250。新增的 `Query.quotas` 是资源配额，不能据此推断 API 请求限额提高。

## 证据入口

- [机器可读实测与 schema 差异](graphql-request-audit-20261010.json)
- [同步后的 schema](../graphql/schema.graphql)
- [创建前解析](../src/commands/issue/issue-create.ts)
- [URL 工作区解析与批量读取](../src/utils/linear.ts)
- [apply 回执读回](../src/delivery/engine.ts)
- [GraphQL 核心发布说明](https://github.com/graphql/graphql-js/releases/tag/v17.0.2)
- [请求客户端发布说明](https://github.com/graffle-js/graffle/releases/tag/7.4.0)
- [Linear 查询与 mutation 文档](https://linear.app/developers/graphql)
- [Linear 速率与复杂度限制](https://linear.app/developers/rate-limiting)

兼容声明：`graphql-request 7.4.0` 的 peerDependencies 仍为 `graphql: 14 - 16`，不含仓库已使用的 `17.0.2`。这是升级前就存在的声明差异；本次未加兼容层，实际行为以本地验证结果为依据。

提交 PR 前的本地验收：同步新 schema 后，GraphQL codegen、源码格式、代码 lint、Markdown lint、AutoCorrect 和类型检查通过。使用独立进程运行完整测试的 4 个分片，共 2,077 个测试、151 个测试步骤通过，4 个测试忽略，无失败。此快照未覆盖 Linux Keyring 集成测试或 GitHub CI；PR 的 CI 状态以对应提交的 GitHub 检查为准。
