# Agent 接口架构

本文件记录现行接口的责任边界和保证。可执行用法由命令树与 [内嵌 Guide](guides/core.md) 拥有；早期计划和一次性交付证据保留在 [历史交付记录](agent-interface-delivery.md) 与 [Skill 迁移记录](skill-migration-ledger.md)，不能据此推断当前能力或发布状态。

## 工具与上下文的责任

CLI 同时服务终端用户、Agent 和无人值守脚本。用户决定目标和授权；程序提供可发现的操作、机械检查和结果。Linear 保存变化中的问题、证据与决定，代码注释保留必要意图及 Issue 链接，确定性约束进入代码与测试，跨任务稳定事实归入知识库。

一个外部 Linear Skill 负责激活和缺失二进制时的引导。命令与跨命令工作流随 CLI 版本分发；宿主策略拥有授权。能力元数据、dry-run、确认参数、登录成功或凭据存在都不扩大授权。

| 事实                              | 权威位置                                                   |
| --------------------------------- | ---------------------------------------------------------- |
| 命令、参数、别名、单命令验证      | `src/commands/` 和实时 Cliffy 命令树                       |
| 根／领域导航与能力发现            | `src/commands/usage.ts`，从树生成                          |
| 跨命令且随版本变化的操作方法      | `docs/guides/`，由 `src/guides/content.ts` 静态嵌入        |
| 上游字段和 typed GraphQL document | `graphql/schema.graphql`、源码 `gql`、codegen              |
| 原始依据比较与机器结果            | `src/utils/replacement.ts`、`errors.ts`、`write-result.ts` |
| 共享业务操作与文件关联            | 命令模块导出的操作与 `src/operations/`                     |
| Issue 组合执行、回执和恢复        | `src/delivery/`                                            |
| VCS、GitHub 组合和组织治理策略    | 可编辑的 `recipes/`                                        |

命令树拥有单命令事实，Guide 只解释多个入口之间的依赖与边界，不生成第二份命令目录。根导航始终可发现；已知叶子命令可以直接调用，不强制执行发现仪式。

## 单命令与薄组合层

```text
参数 / 文件 ──→ 共享 typed operation ──→ GraphQL / 文件传输
                       ↑
                Issue plan / apply

JS / Python ──→ CLI 的 JSON 与文件合同
            └→ raw GraphQL 处理复杂读取及长尾能力
```

常见操作留在专用命令：名称解析、领域校验和实际 mutation 由同一实现拥有。Issue 的 create、update、comment、attachment、relation 与 apply 共用操作函数。apply 不自产 argv、不启动子 CLI，也不复制名称解析与写前守卫。

只提取真实重复的机制，不建立公共 SDK、全资源反射层、通用 delivery DSL 或 recipe runner。已有 CRUD、title/url/describe/mine、上传下载、交互选择和编辑继续保留各自价值。小字段读取只请求对应投影。

以下责任从核心拆出：GitHub PR、autolink、Jujutsu 提交检索、开始工作时的 VCS 编排和 doctor 组织策略。`issue pick` 只选择并输出编号；`team key` 输出可读 key。Project 创建后关联 Initiative、团队迁移后删除均是显式独立效果。替代入口见 [recipes](../recipes/README.md)。

## 原始依据与替换

Issue、Comment、Project、Initiative、Document、Milestone 的读取使用 `{organization, <API 对象>}`，保留稳定 ID、API 字段名和 presence。调用者在讨论或编辑前保存该读取，直接作为 `--base-file` 输入。非交互入口不能现读一个新 base 冒充调用者的原始依据；交互编辑在展示旧内容前固定初读。

replacement 默认要求依据。显式 `--unprotected` 只跳过原值比较，仍执行身份、字段、文件与领域检查；它不替代 Document 行内评论锚点的独立保护。创建、原生增量与追加不强制不存在的旧值。关系新增检查是否会替换既有关系；标签增删保留上游增量语义。

实际 mutation 所有者先完成输入与名称解析，固定 UUID，再进行最后一次观察：额外依赖变化时拒绝；touched 字段与 desired 精确相同则不写，与 original 相同则可写，其余为 conflict。一个字段冲突即拒绝整个对象 patch；无关字段不比较、不提交。

引用按稳定 ID 比较，明确的 ID 集合按集合语义比较。Markdown 不通过泛化规范化放行覆盖或 no-op。服务器可能改写 Markdown；确认写入和实际读回分别报告，不为消除差异重复提交。

这是客户端最后观察检查：不提供服务器 CAS、锁、事务、exactly-once、ABA 检测或最后读取之后的竞争保护。最小可用依据及操作示例见 [automation](guides/automation.md)。

## 效果、分页与回执

专用写入口使用统一 `{ok,effect,data,...}`。effect 为 none、applied、unknown；执行事实和 verification 分开。参数解析、本地拒绝、认证、GraphQL 与网络失败均通过同一机器输出通道。人类诊断在 stderr，JSON stdout 不混入进度。

复合操作保留已确认效果。上传签名申请、字节传输、创建关联分别处理；关联失败不能抹掉可继续使用的上传回执。没有成功确认时，不从错误或非零退出推断零效果；已确认但回执缺失时保留 applied 并阻止自动重发。

完整分页读到 hasNextPage=false，空／循环游标或结构变化显式失败。自动分页只用于 query，原生 api mutation 配合 paginate 在首次请求前拒绝。GraphQL 部分错误不伪装完整成功；跨页读取不承诺数据库快照。

原生 `api --unprotected` mutation 明示跳过专用领域守卫，保留原始 GraphQL envelope；不建立 mutation 到专用命令的第二份目录。它不提供自动重试、回执或 checkpoint，未知效果由调用者对账。具体例外见 [graphql](guides/graphql.md)。

## Issue delivery 与恢复

manifest v2 组合已有 Issue 操作；set 使用其命令选项名称，base/baseFile 保存原生初读。plan 零写入并复用准备逻辑；apply 最后重读并调用同一实际写入实现。整批本地材料在首写前读取和校验，上传前检查指纹。

恢复只有 `src/delivery/checkpoint.ts` 一份账本实现。副作用发射前持久记录 unknown，确认并取得回执后记录 completed；上传回执独立保存。completed 续跑只核验、不重放，unknown 阻止所有自动续跑。单命令不强制创建 checkpoint。

部分成功不回滚，同一清单不能并发执行。旧 schemaVersion 1 清单与账本明确拒绝，保留原文件、匹配的旧版本和对账路径，再为明确剩余工作建立独立 v2；不自动迁移或删除历史记录后重放。状态、输出路径及核验范围由 [issue-delivery](guides/issue-delivery.md) 统一说明。

团队迁移 recipe 只保存固定 UUID 范围和逐项结果映射，失败即停；不泛化 Issue apply 为团队生命周期，也不建立第二个恢复引擎。doctor 的九条规则保存在普通脚本，严重度和时间阈值属于可修改的组织约定。

## 文档与验证

Guide frontmatter 只含 name、description、commands；commands 必须指向现有规范命令。静态 import 保证安装二进制离线可读，测试核对源码文件、注册、命令引用和内容一致。外部 Skill 不重复这些命令事实。

验证覆盖真实生产入口的参数错误、JSON 通道、分页、身份、冲突、mixed no-op/write、部分成功、回执与续跑。故障注入在隔离服务器验证，不将 mock、构建通过或合并当成线上状态。发布验收另外固定实际编译产物、源码版本与执行证据；发布和安装状态分别报告。维护流程见 [AGENTS.md](../AGENTS.md)。
