# Agent 接口架构与交付路线图

状态：已接受的架构与实施计划，经独立设计评审、真实 Issue 交接事故和 2026-08-08 的一次性交付决定修订。本次发布范围的全部 CLI 能力（指南、面包屑、access/authoring 迁移、生成手册移除、upload、delivery plan/apply、batch checkpoint）已在集成分支完成；下一步是发布编排与 skills#219 的 family 原子替换。

## 执行摘要

本架构服务一个统一的目标函数：让信息每经过一次人、AI、代码、Issue 或知识库的转手，尽可能少损失原始意图。任何临时偏离都应保持可理解、可追溯、可验证、可结束，且不要求下一位接手者拥有产生它的对话。信息按形态归位：

| 信息形态                                 | 归属                          |
| ---------------------------------------- | ----------------------------- |
| 尚在变化的问题、调查、决策、证据         | Linear Issue                  |
| 当前位置的必要意图与 canonical Issue URL | 代码注释                      |
| 确定性行为约束                           | 代码与测试                    |
| 跨任务稳定事实                           | OKF 知识库                    |
| 全局维护边界与授权                       | 宿主 AGENTS.md 与系统策略     |
| 可观测现场事实                           | CLI 输出、manifest 与审计产物 |

Linear 是公司动态上下文的容器，代码注释是通往它的路由入口。本 CLI 及其唯一的外部激活 Skill 是这条信息流在 Linear 域的执行工具；同一边界由 ipruning/skills#26（个人宿主指引）与 jihuanshe/skills#219（公司 `preserving-context-continuity` Skill）在各自层面承载。

CLI 应当成为一个版本匹配、可渐进发现的协议，同时服务人类与 agent。Jihuanshe 应当只暴露一个已安装的 Linear Agent Skill 用于第一英里激活；CLI 应当拥有目前分散在外部 Linear Skill 家族中的工作流。

所有权规则是：

> Linear 命令事实和可复用的 Linear 工作流属于 CLI。一个外部 Skill 负责激活 Linear；授权始终是宿主策略，绝不从 CLI 能力推导而来。

由此得到四个层次：

```text
One external Linear Skill
  activation for every Linear task; missing-binary bootstrap only
        |
        v
CLI discovery
  root navigation, usage, domain usage, leaf --help
        |
        v
Embedded guides
  version-matched cross-command workflows and semantic warnings
        |
        v
Execution protocol
  Issue delivery manifest, preview/apply, existing commands, structured output,
  schema-assisted raw GraphQL fallback
```

关键变化不只是让某个 Skill 变短，而是移除相互竞争的外部路由，并把可复用的 Linear 行为迁移到拥有它的版本化程序中。

Issue 是这里最重要的交付边界。标题或正文 mutation 成功，不等于任务已经被可靠交接。CLI 应让 agent 和人类能在一次预览中看到 Issue 字段、Comment 正文中的上传文件、Linear Attachments 和 IssueRelations，并在写入前验证输入、写入后得到逐项结果。指南负责提供正确上下文，交付命令负责避免多条 shell 命令之间的遗漏。

## 动机

### 当前的首次运行体验是死胡同

目前不带参数运行 `linear` 只会打印：

```text
Use --help to see available commands
```

这错失了一个机会：教授渐进式发现、区分命令与工作流，并把 agent 引导到版本匹配的文档。

### 生成的 Skill 参考重复了命令树

当前的 `linear-cli` Skill 包含一份生成的命令目录和每个领域一份生成的参考文件。其中大部分内容是 Cliffy 命令树已经拥有的信息快照：命令名、别名、参数、选项、默认值和描述。

这种重复有三项成本：

- 文档可能与已安装的二进制发生漂移；
- 每次加载 Skill 都可能消耗与当前任务无关的事实；
- 生成器和发布门禁必须维护命令表面的第二套表示。

### 仅有一个薄 Skill 并不够

`lark-cli` 和 `agent-browser` 这类工具中有用的模式，并不只是它们的外部 Skill 很短。领域知识已经迁移到版本匹配的运行时资源中，而外部 Skill 教 agent 如何以及何时发现它们。

内嵌指南解决了版本匹配和内聚问题，但没有解决第一英里激活。在 agent 已经选中 `linear` 之前，一个已安装的二进制无法告诉 agent 去使用它。一个小的外部 Skill 仍然必要，用于：

- 识别每一个 Linear 任务、URL 和标识符；
- 在确切命令尚不确定时，调用 CLI 自身的发现机制和版本匹配的工作流；
- 在 `linear` 缺失时引导安装规范二进制。

访问修复、Issue authoring 和受保护的批量写入是 Linear 产品工作流，不是安装相互竞争的宿主 Skill 的理由。它们应当成为 CLI 命令和内嵌指南。授权仍留在 CLI 之外，由宿主的系统或仓库策略负责。

## 参考模式

### Linearis

[Linearis](https://github.com/linearis-oss/linearis) 展示了 CLI 原生的两级 usage、集中式机器输出、批量变更输入解析和客户端可靠性策略。值得借鉴的部分是这样的原则：CLI 是按需协议，Skill 教的是发现而不是复制每一个 flag。

不应照搬的部分同样重要：这个 CLI 不应变成 JSON-only、削弱破坏性操作保护、静默忽略无效字段投影、不加区分地重试 mutation，或削减现有的原始 GraphQL 逃生通道。

### Lark 路由 Skill

[`lark` 路由 Skill](https://github.com/jihuanshe/skills/blob/main/skills-stable/lark/lark/SKILL.md) 之所以短，是因为详细的、与版本耦合的领域知识从 `lark-cli skills list/read` 读取。它仍保留跨 Skill 路由、执行路径优先级、高风险写入策略和环境恢复。它的经验是：知识迁移到了更好的拥有者，而不是被删除。

### agent-browser

`agent-browser` 结合了有用的无参数 `Start here` 区块、版本匹配的内嵌 Skill 和完整的叶子命令帮助。它表明 CLI 可以按需提供与版本匹配的指导，而不要求宿主 Skill 复制命令手册。

## 设计原则

1. **命令事实只有一个拥有者。** 命令名、参数、选项、别名、默认值和运行时能力来自实时的 Cliffy 树。
2. **版本匹配的工作流只有一个拥有者。** 跨命令的 CLI 手册存放在本仓库并随二进制一起发布。
3. **一个 Skill 负责激活；CLI 负责教学。** 外部 Skill 对所有 Linear 工作只有一条正向路由。命令选择、访问诊断、Issue 受理、批量执行和结果语义属于 CLI 代码、帮助和内嵌指南。
4. **渐进披露是可选项，不是仪式。** 已经知道确切专用命令的 agent 可以直接调用。不确定的 agent 必须有一条不需要猜测的可靠路径。
5. **机器模式绝不授予同意。** `writes: true`、JSON 输出、`LINEAR_PROMPT_DISABLED=1`、`--force`、`--confirm` 和 `--yes` 描述的是能力或执行机制，不是授权。
6. **专用命令先于逃生通道。** 优先使用专门构建的命令，其次是 schema 辅助的 `linear api`，只有当 CLI 无法提供所需控制时才使用直接 HTTP。
7. **文档辅助安全；代码强制安全。** 指南可以解释标签替换、破坏性操作和文档锚点，但运行时校验和确认仍是最终防线。
8. **可发现性是接口，不是安装布局的偶然产物。** Agent 不应需要知道宿主特定的 Skill 安装路径。
9. **保持离线与确定性。** 指南发现不得要求网络访问、embedding 或外部服务。
10. **只在有证据后增加复杂度。** 从小的指南语料和 `list`/`read` 开始。只有当真实使用或针对性的全新 agent 场景暴露具名缺口时，才增加搜索、文件系统投影、更丰富的排序或内嵌的专家工作流。
11. **保留意图，而不是模板。** Issue 指导应帮助不熟悉情况的人或 agent 恢复目标、证据、关闭原因和任何下一跳。它不得要求不增加信息的仪式性章节。
12. **状态是路由信号，不是证明。** 一个已完成的 Issue 告诉 agent 去复查关联工作；它不证明源码、部署或某条临时兼容路径已经可以变更。
13. **一起预览和执行，不等于同步整个远端状态。** Issue 字段、Comment 正文中的上传文件、Attachments 和 IssueRelations 应使用同一份交付清单；未提及的既有对象保持不变。
14. **区分事实源与发现渠道。** 下游消费者、缓存、日志或分析可以暴露问题，但不会因此自动成为负责修复的系统或团队。Issue 应围绕待治理的事实及其验证方式组织上下文。
15. **原始证据优先于创建者记忆。** 一个 hash、本机路径、聊天中的隐式附件或分析摘要不能替代接手者实际需要的原始文件和持久链接。
16. **原语必须赢过 AI 直接写 GraphQL。** AI 已经非常擅长用 Shell、Python 或 TypeScript 直接操作 GraphQL。CLI 只实现赢过这条基线的原语：版本匹配的知识、上传管道这类多步骤 plumbing、并发冲突安全、逐项结果核算。复杂到需要说明书才能用的原语等于失败；长尾操作留给 `linear api`。
17. **协议自由可调。** 没有向下兼容义务，JSON 契约、参数和 schema 在改进设计时可以直接重塑。tolerant-reader 与 schema 版本号是给未来消费者的秩序，不是当前设计的枷锁。
18. **设计权衡留在源码现场。** 影响使用方式的设计决策——为什么这样设计、引导了什么披露、相关指南——写进实现处的模块注释或本文档并互相引用，让没有上下文的下游 AI 在代码现场就能恢复决策语境。这是本轮重构的核心目标之一：Context Engineering。

## 设计评审决定

对第一阶段基线和本架构的一次独立评审接受了四层所有权模型，并为后续 commit 确定了以下决定：

1. 补充的命令能力元数据必须与每个叶子命令定义放在一起，而不是加在父级注册处。一个精确的写命令完整性测试必须让遗漏显式失败。
2. 内部指南搜索不属于初始指南系统。只有四份指南时，`list` 和 `read` 已经足够。搜索或文件系统投影由证据门控。
3. 静态文本导入是首选的嵌入机制。Deno 2.9.4 可以在交叉编译的二进制中嵌入 `import ... with { type: "text" }` 资源，无需生成内容模块。
4. 单命令语义事实属于该命令的描述和帮助。指南拥有真正跨命令的工作流；外部激活 Skill 不得重复那些帮助在执行前就能暴露的事实。
5. 在零参数导航之后、指南编写之前，用少量全新 Amp agent 探测单一激活 Skill 的真实发现路径。探测用于发现缺失上下文，不做统计 A/B，也不自动把每次失败升级成 CLI 功能；先判断它属于命令事实、跨命令指导、宿主策略，还是 agent 可以自行恢复的一次性偏差。最终迁移只在访问诊断、Issue authoring、文件驱动的 Issue 交付和 batch 都有 CLI 拥有者之后进行场景验证。
6. 本地生成参考的移除与最终对 `jihuanshe/skills` 的原子化替换是两个独立的评审边界。
7. 技术审计结果不等于写给接手者的 Issue。CLI 应提供 authoring 指导、风险相称的执行摘要和 update 三方 verdict，但不判断用户是否完成了业务思考，也不把 create 或机械字段更新强制送入一套审批流程；需要审核的新拟正文由 Agent 在对话中展示。
8. 2026-08-08 的用户决定：不做渐进式交付。剩余能力在一个集成分支上以可评审 commit 完成，经一次 merge 触发单个 release，外部 Skill family 在同一发布窗口内原子替换。作为初创组织，向后兼容不是交付约束；发布后的真实使用信号驱动后续优化，预防性门禁不得阻塞完整交付。

这些决定收窄了第一版指南实现，把实证发现提前到序列中更早的位置，并把交付边界从多次发布收敛为一个发布窗口。

## 知识所有权

### 属于 CLI 命令树的内容

- 命令和领域名称；
- 别名；
- 位置参数及其类型；
- 选项、默认值、静态必填要求、列表与可重复行为；
- 命令描述；
- 命令是否可以写入；
- 是否可以交互提示；
- 实际的确认绕过选项（如有）；
- 支持的输出模式；
- 单个叶子命令的完整参考。

这些内容应当由 `usage`、`usage --json` 和叶子 `--help` 暴露，而不是复制进生成的 Skill 参考。

有些能力事实无法从 Cliffy 的语法中机械推断。它们的注解必须与所描述的 action 位于同一个叶子模块中，让修改命令的贡献者同时看到行为和元数据。必须有一个测试固定被归类为写入的精确规范路径。父级领域接线不得成为隐藏的能力注册表。

### 属于内嵌 CLI 指南的内容

- 如何渐进地发现命令；
- stdout/stderr、JSON、退出状态和无人值守自动化契约；
- 专用命令与原始 GraphQL 的选择；
- 编写并验证多步操作；
- 在创建或更新 Issue 时澄清请求、收集证据，并将其塑造成一个或多个可独立接手的 Issue；
- 区分权威事实源、发现渠道、下游影响、负责修复的系统或团队，以及如何验证完成；
- 判断原始证据是否已经通过持久附件或链接进入 Issue，而不是留在本机或原聊天；
- Markdown 文件 flag；
- 完整标签集替换与增量标签变更的区别；
- 编写能在交接中存活的 Issue：使用持久链接，并在工作继续时以关闭原因加可点击的下一跳收尾；
- schema 发现、变量、分页和 GraphQL 兜底；
- Issue delivery manifest 的 plan/apply、逐项结果、checkpoint 和保守续跑语义；
- 单次和 batch 复用同一个 manifest。

这些内容由产品拥有且往往依赖版本，但它们跨越多个命令，放不进 flag 描述。

能由单个命令完整陈述的事实必须留在该命令的描述中。例如，`issue mine` 限定当前用户、`issue attach` 创建 Linear Attachment，应当能直接从这些命令的帮助中发现。指南可以解释更广的查询或附件工作流，但不得成为叶子事实的唯一或重复拥有者。

### 留在 CLI 之外的内容

- 某个任务是否应当激活 Linear 工具链；
- 显式授权和宿主的外部写入边界；
- 组织特定的安装与凭据策略；
- 环境路由，例如 macOS 与 exe.dev 之间的选择；
- 拥有者身份、Reflection、集成选择和密钥处理策略；
- 关于把源码本地的临时行为关联到 Issue、并决定创建该外部对象是否获得授权的组织或宿主策略；
- 浏览器、日志、仓库、对话或其他宿主工具的可用性与授权。

这些策略已经来自宿主系统提示、仓库指引和当前用户任务。它们不应需要单独的 Linear Skill。内嵌的受理指导可以告诉 agent 一个有用的 Issue 需要哪些证据，而宿主决定允许哪些工具和写入。

### 当前的 `jihuanshe/skills` Linear 家族

当前家族已由 skills#219 收敛为一个外部激活 Skill（随发布编排合并）：

| 当前 Skill                 | 迁移目标                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `linear-cli`               | 重命名或替换为单一的外部 `linear` 激活 Skill。在 CLI 发现和内嵌工作流通过确定性测试与关键场景验证后，移除其命令手册。 |
| `linear-access`            | 将诊断、认证和修复迁入 CLI 命令与内嵌指导。在单一激活 Skill 中只保留二进制缺失的引导事实，然后删除本 Skill。          |
| `linear-request-intake`    | 将澄清、事实归属、证据质量、Issue 拆解和撰写指导迁入 CLI 的 Issue authoring 工作流。在语义用例通过后删除本 Skill。    |
| `linear-issue-batch-write` | 将 plan/apply、冲突、检查点和恢复迁入一等 CLI 命令和一份内嵌指南。在行为与恢复测试通过后删除本 Skill。                |

## 渐进式命令发现

### 第一阶段基础

第一阶段基线新增：

```bash
linear usage
linear usage --json
linear issue usage
linear issue usage --json
```

这些文档由实际的 Cliffy 命令树生成。补充语义使用 Cliffy 原生元数据，包括：

- `writes`；
- `interactive`；
- `confirmation`；
- `outputModes`。

JSON 契约目前为 `schemaVersion: 1`。隐藏命令和选项保持隐藏，别名解析到规范路径，叶子细节继续通过 `--help` 获取。

实测的第一阶段输出大小提供了初始发现预算：

| 调用                        | 字节数 |
| --------------------------- | -----: |
| `linear`                    |  1,683 |
| `linear usage`              |  1,683 |
| `linear usage --json`       | 12,744 |
| `linear issue`              |  9,973 |
| `linear issue usage`        |  9,973 |
| `linear issue usage --json` | 52,505 |

简洁的根视图适合作为默认入口。issue 领域的 JSON 对结构化工具有用，但太大，不宜推荐为无条件的第一读；agent 应当只在需要时再进入单个领域或叶子。

已完成的第一阶段加固：

- 补充元数据注解与其定义和 action 一起位于叶子命令模块中，而不是父级接线文件里；
- 一个包含隐藏命令的精确完整性测试，固定了全部能修改持久远端状态或用户配置本身的规范路径（清单的 canonical home 是该测试自身）。瞬态缓存、下载得到的只读副本和显式导出被排除，因此 `issue view` 不会被误报成 Linear mutation；
- 测试冻结了 `Writes`、`Interactive`、`Confirmation required unless`、`Output modes` 这些 Cliffy 标签，以及人类 `usage` 输出中的小写标签；
- 选项省略 `default` 意味着：要么没有可在 usage JSON v1 中表示的静态默认值，要么是动态或不可序列化的默认值，并不必然表示运行时没有默认值；
- usage JSON v1 的读取方忽略新增字段。Schema 版本 1 在只增加字段时保持有效；移除或改变现有字段的类型需要递增版本。

### 根导航

不带参数调用 `linear` 应当产生一个简洁的导航页，而不是只把用户指向 `--help`。它应当保持足够小，适合 agent 默认消费。

示意的最终形态输出：

```text
linear — Work with Linear from the command line

Start here:
  linear usage                  Discover available domains
  linear issue usage            Discover issue commands and options
  linear issue create --help    Read one command's full reference
  linear guides                 List version-matched workflow guides
  linear guides read core       Read the automation and safety contract

Long-tail GraphQL:
  linear schema
  linear api --help

Commands:
  auth          Authentication and identities
  issue         Issues, comments, attachments, and relations
  project       Projects
  initiative    Initiatives
  ...
```

根 action 应当复用现有的 usage 文档，而不是再建一套命令目录。零参数导航 commit 最初只能提及当时已存在的命令；`guides` 条目只在指南命令发布后加入。

### 领域导航

不带叶子调用符合条件的命令领域（如 `linear issue`）应当显示与 `linear issue usage` 相同的渐进式领域视图。这只适用于当前无参数 action 显示帮助的领域。像 `config` 这类无参数 action 执行实际工作的命令被明确排除。领域输出只在指南发布后才获得相关指南摘要，且不得打印完整指南正文。

### 叶子参考

叶子 `--help` 仍是精确的命令参考。单命令语义直接属于命令描述。当确实存在相关的跨命令工作流知识时，叶子可以额外获得一个简短的 `Related guides` 区块：

```text
Related guides:
  issue-authoring
    Labels replace the complete set; use file flags for Markdown.
    Run: linear guides read issue-authoring
```

帮助条目是面包屑，不是指南的内嵌副本。

### 上下文恢复

当失败源于不明显的产品语义时，选定的校验错误最终可以链接到一个精确的指南章节。这项工作推迟到全新 agent 场景揭示具体恢复失败之后；通用错误不得增加指南噪音。

适合的场景包括：

- 替换完整标签集；
- 混淆 Linear Attachment 与 Comment 正文中的上传文件；
- 文档锚点安全；
- 批量冲突或恢复步骤。

## 内嵌指南

### 源码布局

规范 Markdown 应当存放在本仓库：

```text
docs/guides/
  core.md
  automation.md
  issue-authoring.md
  graphql.md
  issue-delivery.md     # added with first-class plan/apply delivery
```

第一版实现应当只包含 `core`、`automation`、`issue-authoring` 和 `graphql`。小语料让我们在迁移每本现有手册之前先验证接口。`issue-authoring` 的名字有意强调它不是 Markdown 风格手册：它拥有从请求和证据到完整 Issue 交付的判断框架。

### 元数据

每份指南应当包含结构化元数据，例如：

```yaml
---
name: issue-authoring
title: Authoring and updating complete issues
description: Source-of-truth boundaries, durable evidence, complete delivery, closure, and next hops
keywords:
  - issue
  - update
  - handoff
  - source-of-truth
  - evidence
  - closure
  - next-hop
  - markdown
  - label
  - attachment
  - 标签
  - 附件
commands:
  - issue create
  - issue update
  - issue comment add
  - issue attach
seeAlso:
  - automation
---
```

命令到指南的关系由指南元数据拥有，而不是命令注册。构建过程派生一个反向索引，并验证每个规范命令和 `seeAlso` 指南都存在。这避免了第二个手工维护的命令到指南注册表。

### 构建期嵌入

Markdown 在仓库中保持人类可读、便于 grep。发布构建把它嵌入编译后的二进制，使已安装文档始终与已安装的 CLI 版本一致。

第一版实现使用 Deno 稳定的静态文本导入：

```ts
import core from "../../docs/guides/core.md" with { type: "text" }
```

Deno 2.9.4 会把可静态分析的文本导入嵌入 `deno compile` 使用的模块图，包括交叉编译。一个小的显式导入清单作为构建清单是可接受的，但测试必须将它与 `docs/guides/*.md` 对比，避免新指南被静默遗漏。Markdown 仍是唯一的内容来源。

在依赖该机制之前，先验证 `deno check`、lint、Markdown 格式化、仓库的发布/类型检查，以及编译后二进制的指南读取冒烟测试。如果文本导入与这些路径冲突，回退到生成的 TypeScript 资源模块，并做真实的源到生成物字节相等检查。

指南系统不导出 Agent Skill、不创建宿主 frontmatter，也不重建命令参考。

## 指南 CLI

### 必需命令

```bash
linear guides
linear guides list
linear guides list --json
linear guides read <name>
```

`linear guides` 应当是简洁列表视图的别名。

### 输出契约

- `guides list` 向 stdout 写入简洁的人类索引。
- `guides list --json` 保留稳定的名称、描述、关键词和相关规范命令路径。
- `guides read` 只向 stdout 写入所选 Markdown 正文。
- 任何指南命令都不要求认证或网络访问。

## 搜索与文件系统投影延后

初始指南系统不实现 `guides search`、`guides path` 或 `guides export`。全新 agent 场景只需记录 `guides list`、命令面包屑和直接阅读是否足以找到相关知识。出现具名失败后，再根据实际消费者选择搜索或文件系统投影，并单独设计接口。

## 命令元数据中的指南可发现性

由指南 frontmatter 派生的反向索引应当供给每一个发现面：

- 根导航列出核心指南入口；
- 领域 usage 列出直接相关的指南；
- 叶子帮助列出一到两个相关指南；
- `usage --json` 包含简洁的指南元数据；
- `guides list/read` 使用同一套内嵌语料和索引。

示意的 `usage --json` 扩展：

```json
{
  "name": "update",
  "path": "linear issue update",
  "writes": true,
  "interactive": true,
  "confirmation": null,
  "outputModes": ["human"],
  "guides": [
    {
      "name": "issue-authoring",
      "description": "Source-of-truth boundaries, durable evidence, and complete Issue delivery"
    },
    {
      "name": "automation",
      "description": "Unattended execution and write verification"
    }
  ]
}
```

Usage JSON 遵循宽容读取方策略：同一 schema 版本内可以出现未知的新增字段。因此加入 `guides` 仍保持 `schemaVersion: 1`；移除或改变现有字段的类型需要递增版本。测试必须断言在指南元数据出现时，所有现有 v1 字段保持不变。

## Issue 交付原语

### 事故揭示的边界

一次真实的数据治理交接暴露了当前接口的核心缺口：技术审计提供了大量正确细节，但 Issue 被写成了审计者自己的速记和下游消费方需求，接手者无法判断真正需要治理的业务事实、负责系统和如何验证完成。图片后来被补充了，原始 Replay 却最初只留下摘要、hash 和创建者机器上的上下文；批量更新成功修改了正文，但评论和文件仍靠 agent 手工拼接。

这不是固定模板缺失，也不能只靠更长的 Skill 解决。CLI 需要一个文件驱动的多步骤 Issue 交付命令，使 Issue 字段、Comment 正文中的上传文件、Linear Attachments 和 IssueRelations 能一起预览、写前校验、执行并逐项报告。

### 与 Linear 上游模型对齐

V1 使用 Linear GraphQL 已有对象，不再发明平行集合：

- `comments[].files` 对应上传文件并把 asset URL 写入 Comment Markdown；它不是 Linear `Attachment`；
- `attachments` 对应 Linear `Attachment`。输入可以来自本地文件或 URL；现有 `issue attach` 和 `issue link` 最终都创建这个对象；
- `relations` 对应 Linear `IssueRelation`；
- Issue 的 title、description、state、priority、labels、assignee 等继续使用现有 create/update 字段。

Attachment 的 URL 在同一 Issue 内具有上游定义的唯一性，重复 URL 会更新既有 Attachment。这个约束不代表其他 mutation 也能安全重复提交；V1 不据此发明通用幂等协议。

### 上传原语与富文本

Linear 的描述和评论是真正的富文本：表格单元格可以嵌图片，AI 会上传 PDF、图片和各类 artifact，最终多数以 Comment 形式进入 Issue。支撑这一切只需要一个原语：

```bash
linear upload <file...>
```

上传文件并返回 asset URL，连同 public/private 与 MIME 信息。上传管道——`fileUpload` mutation、签名 `uploadUrl` 与 headers、PUT、`assetUrl`——已存在于 `src/utils/upload.ts`，目前只被 `issue attach` 和 `issue comment add --attach` 内部消费。暴露为独立命令后，AI 可以把 URL 嵌进任何 Markdown 位置——描述、评论、表格单元格——CLI 不需要为「富文本」建任何额外表面。manifest 的 `comments[].files` 只是这个原语加正文追加的组合语法糖。

这个原语过「值得性」门槛的原因：三步上传舞蹈、认证 headers 和 public/private 语义是纯 plumbing，AI 用原始 GraphQL 每次都要重新拼。相反，「把 Markdown 写对」不需要原语——那正是 AI 已经擅长的部分。

### `issue-authoring` 指南

指南为人和 agent 提供写好 Issue 所需的上下文，不充当强制审批流程，也不要求生成中间文档。它应帮助回答：

- 接手者需要做什么；
- 哪个系统、仓库或数据集拥有待修复的权威事实；
- 当前现象是直接事实，还是来自下游消费者、缓存、日志、Replay 或派生分析；
- 哪个系统或团队负责修复，以及如何验证完成；
- 哪些是已验证事实，哪些仍是推测；
- 关键证据是否已经通过接手者可访问的文件或 URL 交付，而不是只留在当前聊天或创建者电脑。

发现问题的系统不自动拥有修复。一个下游分析发现主数据异常时，Issue 应围绕主数据事实、负责维护入口和正式查询结果组织；下游分析只是影响和证据。反过来，如果未知标识只存在于第三方或引擎内部，且没有权威证据证明它代表正式业务实体，就不应为了让下游解析成功而污染主数据。

图片、Replay、日志、trace、HAR、视频、数据样本或 SQL 导出若是复查所必需，就应实际进入 Issue，并说明来源、用途、复查方法，以及它证明什么、不证明什么。文件名、hash 和本机路径可以补充完整性信息，但不能替代文件。

### Issue delivery manifest

单次与批量交付共享一个版本化清单。示意结构：

```json
{
  "schemaVersion": 1,
  "workspace": "jihuanshe",
  "issues": [
    {
      "operation": "update",
      "identifier": "DATA-606",
      "set": {
        "title": "调查回放中未知卡牌编号的来源（附原始证据）",
        "descriptionFile": "description.md"
      },
      "comments": [
        {
          "bodyFile": "replay-evidence.md",
          "files": [
            { "path": "replay-a.yrp" },
            { "path": "replay-b.yrp" }
          ]
        }
      ],
      "attachments": [
        {
          "kind": "url",
          "url": "https://example.com/source-evidence",
          "title": "Source evidence"
        }
      ],
      "relations": [
        { "type": "related", "issue": "DATA-580" }
      ]
    }
  ]
}
```

Markdown 和二进制内容通过相对于 manifest 的文件路径输入，避免 shell quoting、参数长度和漏传附件。V1 不提供既有 Comment、Attachment 或 IssueRelation 的显式 update/remove；提交 Attachment 时仍遵循 Linear 的同一 Issue 内 URL upsert 语义。清单未提及的其他既有内容保持不变。已有的直接 update/delete 命令继续处理明确的单项修改。

### `plan`

命令定名为 `issue plan`，动词直接挂在 issue 域下，与 create/update 风格一致，不设 `delivery` 名词层级：

```bash
linear issue plan --file delivery.json
```

`plan` 必须：

1. 对远端零写入；允许只读解析 workspace、Issue、字段值和 IssueRelation target。
2. 输出与风险相称的结构化执行摘要：create 展示目标、标题和关键归属，长正文显示 inline/file 来源与大小，文件正文附 hash，并逐项列出 Comment 上传公开性、文件、Attachment 和 IssueRelation；update 展示本次字段的三方 verdict，IssueRelation 展示 add/idempotent/conflict。同一对 Issue 已有不同类型或方向的关系时必须拒绝，不能让 Linear 的 create mutation 隐式替换旧关系。plan 不复制完整长正文，也不充当人类审批界面；同 URL 的 Attachment 可能更新既有对象。
3. 在第一笔 mutation 前验证整个 manifest 的全部本地文件，包括存在性、可读性、大小和 MIME。
4. 对 update 只比较本次要修改的字段，沿用现有 batch 对 workspace、目标 Issue、team、workflow state 和字段变化的保护。这是 CLI 拥有的并发安全兜底：AI 准备材料需要时间，期间上游 Issue 可能已被他人修改。无关评论或 Attachment 变化不制造冲突。
5. 输出确定的执行顺序、解析结果、文件 size/MIME/SHA-256 和结构化机器结果。

`plan` 是可选的零副作用预览，不是每次写入前的强制仪式。调用者已经明确目标时，可以直接执行 `apply`；`apply` 自己仍须在第一笔 mutation 前完成同样的输入验证。V1 不冻结完整 Issue 历史，也不替用户授权写入。

### `apply`、部分成功与续跑

执行入口：

```bash
linear issue apply \
  --file delivery.json \
  --confirm-workspace jihuanshe
```

`apply` 应复用现有 create/update/comment/attach/link/relation 命令实现，而不是建立第二套 API client。它必须：

- 在整批首笔 mutation 前验证 workspace、manifest 结构和全部本地文件；每个 Issue 的目标与字段在该 Issue 自己的首笔 mutation 前验证；
- 按 manifest 顺序执行 Issue 字段、Comment 及其上传文件、Attachment 和 IssueRelation；
- 为每个请求项返回 `applied`、`failed`、`unknown` 或 `unattempted`，成功项带远端 ID/URL；
- 在请求前记录正在执行的步骤，每个确认成功的步骤后更新简单 checkpoint；进程中断时，正在执行的步骤视为结果未知；
- 失败后保留并报告已经成功的结果，不回滚、不删除重建；
- `applied` 项在续跑时跳过；确认未产生副作用的 `failed` 项可以按调用者选择继续或重试；
- `unknown` 立即停止当前 apply 或 batch，在显式对账前不得续跑或重试。

执行结束后读取每个本次已应用或从 checkpoint 恢复的目标 Issue 的当前视图并随结果返回。mutation 成功但读回失败时，执行项保持 `applied`，整体返回 `applied-unverified` 和非零退出；续跑跳过 mutation 并重试读回。V1 不自动遍历并对账全部历史对象，也不把读回结果保存成远端快照。

### Batch 只是多个 Issue

同一个 manifest 的 `issues[]` 同时支持单次和 batch。Batch V1 只额外需要：

- 整批本地可验证输入在首笔 mutation 前验证；远端引用与字段按 Issue 在其首笔 mutation 前验证；
- 顺序执行；
- 逐 Issue、逐请求项 checkpoint；
- 对确认无副作用的 `failed` 使用 stop/continue 策略；`unknown` 始终立即停止；
- 部分成功和剩余项的精确汇总。

V1 不需要并发执行、通用事务日志、集合协调器或独立的 batch schema。

### 明确的非目标与后续证据门禁

V1 不：

- 在 CLI 内调用 AI 自动编写 Issue 或判断业务事实；
- 强制所有 Issue 使用统一的大型 Markdown 模板或审批流程；
- 把 TCG Wiki、卡牌 Password 或其他领域规则硬编码进通用 CLI；
- 提供既有 Comment、Attachment 或 IssueRelation 的显式 update/remove；
- 冻结完整远端快照、实现通用三方状态机或全分页历史审计；
- 用自建远端事务回滚已经成功的 Linear mutation；
- 把 Issue 状态当成清理代码或关闭后续工作的充分证据。

只有实测表明手工对账持续昂贵时，才研究 Linear API 是否支持可靠的重复提交识别。既有集合项的修改和删除、全分页审计、并发 batch 和更复杂的 Markdown 等价判断同样由具名需求与测试证据门控。

## 单一外部 Skill

最终安装的外部 Skill 应当命名为 `linear`，覆盖完整的正向激活空间：Linear URL 与标识符、workspace 读写、认证与安装故障、从请求到 Issue 的受理，以及批量操作。它应当只保留：

- 正向与负向激活边界；
- 一条指令：使用已安装的 `linear` CLI 并遵循其上下文发现；
- 规范的二进制缺失引导路由，因为一个不存在的程序无法描述自己的安装方式。

它不应包含：

- 完整的命令目录；
- 每个领域一份静态参考文件；
- 复制的 flag、别名、默认值或参数类型；
- GraphQL schema 快照；
- 访问、受理、批量或 Issue 撰写手册；
- 在每个已知操作前必须运行版本、usage 或指南发现的要求；
- 宿主与当前任务已经提供的授权策略。

这个 Skill 的存在是为了让 agent 选中 `linear`，不是为了监督 CLI。知道确切命令的 agent 直接调用。根导航、命令帮助、校验错误和相关指南面包屑只在需要时提供发现。

### 引导与版本收敛

未来的 `jihuanshe/skills` 重写必须保留二进制缺失引导路由。兼容性检查属于 CLI 启动、诊断和自更新代码，而不是外部 Skill 中的强制预检。

现有的常规版本探针是：

```bash
linear -V
```

纯版本字符串不能证明分发身份或安装归属。稳定的只读机器探针是：

```bash
linear version --json
```

其 v1 契约为：

```json
{
  "schemaVersion": 1,
  "distribution": "jihuanshe/linear",
  "version": "0.0.1780000000-gabcdef0",
  "capabilities": ["usage-v1"]
}
```

版本 JSON v1 是只增的。读取方要求 `schemaVersion: 1`、精确的 `jihuanshe/linear` 分发标识，以及其集成所需的每一个 capability；它们忽略未知字段和未知 capability 标识符。初始 capability 词汇是 `usage-v1`；本次发布扩展为 `usage-v1`、`guides-v1`、`delivery-v1`（现行词汇见 `src/commands/version.ts`）。CLI 诊断应当报告缺失或不兼容的 capability，而不是要求外部 Skill 去分类第二条 Linear 路由。

该探针识别的是构建，不是包管理器。安装归属仍需要来自 `mise which linear`、`type -a linear`、解析出的可执行文件路径或组织管理器的证据。

引导与诊断流程必须区分五种情况：

| 状态                                                           | 动作                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 具备所需 capability 的兼容 `jihuanshe/linear`                  | 直接执行请求的命令。只在需要时使用版本匹配的发现；不要在每个任务上执行网络更新。                                                                                         |
| 用户或策略明确希望更新的兼容 fork                              | 使用 `linear update`；由 mise 管理的二进制执行工具范围内的 `mise up`，独立发布版则在替换前验证校验和。无需卸载。                                                         |
| 二进制缺失                                                     | 单一外部 Skill 使用规范的组织引导路由，然后回到 CLI。                                                                                                                    |
| shell 解析到外来或冲突的二进制，且存在具备诊断能力的规范二进制 | 通过规范的、由管理器解析的 Jihuanshe 二进制调用诊断，而不是那个冲突的 shell 解析可执行文件。诊断报告观察到的身份和安全的下一步动作；移除或全局配置变更仍由宿主授权管辖。 |
| 没有规范二进制，或规范二进制缺少所需的诊断/更新 capability     | 先使用已授权的 mise 或 Rotom 引导/更新路径，然后通过得到的规范二进制调用诊断。绝不要求外来二进制实现 Jihuanshe 诊断。                                                    |

对受支持的非受管机器，本仓库的规范安装命令是：

```bash
mise use -g "github:jihuanshe/linear[minimum_release_age=0s]@latest"
```

验证必须先使用 mise 选中的二进制，再使用 shell 解析的二进制：

```bash
mise which linear
"$(mise which linear)" version --json
command -v linear
linear version --json
linear usage
```

如果另一个安装遮蔽了 mise，通过 `"$(mise which linear)"` 调用未来的诊断命令，让已知的 Jihuanshe 二进制把自身与 shell 解析的可执行文件对比。如果没有可用的规范二进制，或该二进制太旧而无法安全诊断或更新，先使用已授权的引导/更新路径再诊断。npm、Homebrew、Deno 和手工复制的二进制有各不相同的移除流程；任何通用 `rm` 或猜测的 `npm uninstall` 命令都不安全。移除手工安装或来历不明的可执行文件是破坏性操作，需要用户显式授权。

在 Jihuanshe 受管机器上，当前的权威策略不同：Rotom 拥有受管的 mise 配置。安全的探针和收敛路径是：

```bash
rotom status --format json
rotom inspect latest --format json
rotom setup
```

外部 Skill 不得用直接的全局 `mise use` 绕过 Rotom，除非组织有意在其宿主指引和 Rotom 文档中改变该策略。未来把所有宿主标准化到直接 mise 的决定，是一次有协调的组织策略迁移，不是一次顺手的 Linear 文档编辑。

检查兼容性是只读的。卸载另一个分发或写入全局 mise 配置，并不隐含在一个普通的 Linear 读取任务中；宿主授权边界仍然适用。

### 为什么一个激活 Skill 仍留在外部

这一个外部 Skill 解决第一英里激活。选中之后，CLI 拥有 Linear 产品行为；宿主系统、仓库和用户策略继续拥有授权与跨工具可用性。内嵌内容无法激活一个 agent 尚未考虑的二进制，但这个局限只需要一段覆盖面广的加载描述，不需要为每个 Linear 工作流各设一个 Skill。

不需要复杂的 Skill 导出。外部 Skill 指向 `linear`；程序的根导航、命令帮助和上下文面包屑暴露稳定的发现入口，宿主工件无需镜像或编排它们。

## 生成文档迁移

`generate-skill-docs` 流水线已随 commit 7b 移除：生成的命令目录和每领域参考被删除，实时命令树成为命令事实的唯一拥有者，替代契约由测试套件持有。现行验证包括：

- 指南 frontmatter 可解析且名称唯一；
- 每个相关规范命令存在于 Cliffy 树中；
- 每个 `seeAlso` 指南存在；
- 每个命令领域暴露渐进式 usage；
- 写入与确认元数据保持完整；
- 内嵌 Markdown 与源文件逐字节一致；
- 单一激活 Skill 只引用真实、稳定的入口；
- 发布产物在没有源文件的情况下可以列出并读取内嵌指南。

人工整理内容按迁移台账逐节分类到命令树、内嵌指南、二进制缺失引导或宿主策略，没有任何一节仅为减少字节而丢弃；见 [skill-migration-ledger.md](skill-migration-ledger.md)。

## 验证策略

验证分为确定性 CLI 测试和少量全新 Amp agent 场景。二者回答不同问题，不建设一个让旧 Skill 与新架构竞争的统计评测平台。

### 确定性 CLI 测试

CLI 测试拥有机器能够可靠裁定的契约：

- 命令、usage、help、指南和 JSON schema；
- 文件输入、manifest 解析和写前校验；
- `plan` 零副作用以及 `apply` 的顺序和逐项结果；
- checkpoint、部分成功和 mutation 结果未知时停止；
- 专用命令与 GraphQL fallback；
- 机器输出纯净性、破坏性确认和禁用提示行为。

这些行为不使用 agent 判断，也不因某次 agent 猜错命令而增加额外协议。曾用于 family 对比的 codex eval 装置（`evals/linear-cli-skill`）已在发布前撤除：它的 baseline Skill family 与被测 Skill 工件都已迁出本仓库，独有价值只剩冻结语料的跨次可比性，而该需求随替换决策完成而结束。语义与行为场景由交付记录中的 fresh-agent 场景清单承载——任何宿主 agent 都能按清单起无上下文探针并以现场证据裁决；将来若需要定量比较 Skill 变体，在 skills 仓库按当时现实重建。

### 全新 Amp agent 场景

在需要验证激活、上下文发现或自然语言指导时，启动没有当前对话历史的全新 Amp agent。每个场景只运行足以观察真实路径的少量实例，记录其读取了什么、调用了什么、产物能否由陌生接手者理解。失败是调查信号，不是自动新增功能的指令。

场景覆盖：

- **激活正例与反例**：Linear URL、Issue ID 和普通 Linear 请求应加载唯一 Skill；无关代码任务不应加载；
- **已知与未知命令**：已知命令直接执行；不确定时可从根导航、领域 usage、叶子 help、错误或相关指南恢复；
- **访问与授权**：二进制或认证故障能取得版本匹配的诊断；CLI 能力、机器模式和确认 flag 不被解释为用户授权；
- **Issue authoring**：陌生接手者能理解正常目标、实际偏离、权威事实源、下游发现渠道、证据、处理动作和验收边界；
- **上下文交接**：原始图片或文件进入可访问附件，不留下创建者机器路径；关闭原因和仍存在工作的下一跳可点击；
- **交付与 batch**：完整 Issue 可以一起预览，文件先校验，部分成功可恢复，unknown outcome 不被盲目重试；
- **逃生通道**：专用命令不覆盖的长尾操作使用 `linear api`，不把 fallback 变成默认路径。

### 如何解释失败

发现失败后，先判断最小正确拥有者：

1. 命令名、参数或输出事实缺失，修改命令树、help 或运行时校验；
2. 跨命令且可复用的 Linear 工作流缺失，修改内嵌指南；
3. 二进制尚未进入执行上下文，修改唯一激活 Skill 的最小路由；
4. 授权、组织安装策略或跨工具取证问题，留在宿主策略；
5. Agent 已能通过现有上下文合理恢复，或者只是一次性偏差，不新增机制。

不得因为一个 agent 猜错命令就增加兼容 alias，不得因为一份 Issue 写差就强制巨大模板，也不得为了让场景全绿把领域业务规则硬编码进通用 CLI。

### 事故导出的语义用例

下面的用例固定本设计要解决的问题。领域名和示例数据服务于可理解性；观察的是可推广的行为，不要求把这些领域规则硬编码进 CLI。

#### 权威事实源与下游症状

输入：一个分析系统从 Replay 中发现正式卡牌 Password 与资料库记录不一致，并要求创建资料库 Issue。

期望：

- Issue 明确资料库是待修复事实源，分析系统是发现渠道和影响证据；
- 修复动作属于资料库负责团队，并通过资料库及其正式 Production 查询接口验证；
- 「重跑分析系统」不成为资料库负责团队的完成条件；
- 若事实源或负责团队无法由证据确定，agent 在写入前向用户确认。

#### 原始证据独立交接

输入：104 份 Replay 出现未知编号，当前有 3 份代表性原始 `.yrp`。

期望：

- 三份原始文件进入 manifest，并通过 Comment 正文中的上传文件或 Attachment 实际进入 Issue；
- 附件说明来源、用途、复查方法，以及能证明和不能证明的结论；
- hash、文件名和大小只作为完整性信息，不替代原始文件；
- Issue 不依赖本机绝对路径、当前聊天或未上传的分析 bundle；
- 未证明未知编号是正式实体前，不要求权威资料库创建记录。

#### 技术审计不能替代接手者上下文

输入：根据技术审计批量重写 5 张已有 Issue 的标题和正文。

期望：

- agent 使用 `issue-authoring` 判断事实源、负责团队、业务影响和验证方式；
- plan 展示每张 Issue 本次拟修改的正文，以及拟新增的 Comment 及其上传文件、拟提交的 Attachment 和拟新增的 IssueRelation；
- CLI 不把技术审计自动视为已经写好的 Issue，也不要求扫描全部历史对象；
- apply 逐项报告本次请求的结果，而不是只报告 `description` 已变化。

#### 机械字段更新保持轻量

输入：对一组已确认 Issue 只修改 priority、state、labels 或 assignee。

期望：

- 在已有宿主授权和明确目标下可以直接 apply；调用 plan 时只展示相关字段差异；
- 不要求编造完整业务叙事或重新 authoring 正文；
- 仍保留 workspace 确认、冲突保护和结构化结果。

#### 部分成功、Markdown 往返与恢复

输入：正文 mutation 已成功，但第二个附件上传失败；或者 Linear 改写等价 Markdown，使本地文本比较不相等。

期望：

- 不删除或重建已成功的 Issue；
- 逐项报告 Issue 字段、Comment 正文中的上传文件、Attachment 和 IssueRelation 状态；
- 明确区分 `applied`、`failed`、`unknown` 和 `unattempted`；
- checkpoint 续跑跳过已确认的 `applied` 项，并在 `unknown` 项停止自动重试；
- 不把 `verification_failed` 直接解释为「远端未变」并盲重试。

#### 无仪式性 preflight 与旧二进制恢复

输入分别覆盖：agent 已知一个正确命令；shell 解析到外来旧 binary；规范管理器 binary 可诊断、缺 capability 或不存在。

期望：

- 已知命令直接执行，不强制 `version`、`usage`、`guides list/read` 前置链；
- 需要发现时从根导航、help、错误或相关指南恢复；
- 可用的规范 binary 诊断 PATH shadowing，不让外来 binary 执行组织诊断；
- 缺失或过旧时只使用宿主已授权的规范 bootstrap；
- 不猜包管理器、不擅自删除 binary 或修改全局配置。

### 解读

目标不是让场景全绿，也不是孤立地最小化 Skill 字节数。验证应证明关键能力有明确拥有者、陌生接手者能恢复意图、CLI 的机械契约可测试，并且唯一激活 Skill 不再复制手册。少量 agent 场景提供路径证据，不提供统计等价，也不能凌驾于已经确认的产品边界和真实事故事实。

## 交付

本设计的一次性交付记录——已完成的 commit 序列、两仓库发布编排、发布后信号驱动工作与完成定义——见 [agent-interface-delivery.md](agent-interface-delivery.md)。被替换 Skill family 的逐节去向见 [skill-migration-ledger.md](skill-migration-ledger.md)。

## 已考虑的替代方案

### 保留当前生成的 Skill 手册

作为长期设计被否决，因为它重复实时命令事实、急切消耗上下文，并可能与已安装版本漂移。在替代方案通过确定性测试和关键场景验证之前，它仍是迁移基线。

### 移除所有外部 Linear Skill

被否决，因为内嵌资源无法在 agent 选中二进制之前提供第一英里激活。这需要恰好一个覆盖面广的外部 Linear Skill，而不是一个按工作流切分的家族。

### 添加 `linear skills list/read`

延后。初始指南语料很小，而且把产品手册称为 `guides` 能把版本匹配的运行时资源与那一个外部激活 Skill 区分开。如果指南语料超出简单的手册模型，可以重新考虑专家型内嵌 Skill 系统。

### 依赖宿主 Skill 目录 grep

作为主要契约被否决，因为 Skill 位置因宿主而异，且静态 Skill 内容可能与已安装二进制不一致。`guides list/read` 直接从已安装二进制提供版本匹配的内容。

### 立即添加内部搜索

延后，因为四份指南可以简洁列出并直接阅读。当全新 agent 场景显示这些入口仍造成实际检索失败时，内部搜索才有理由。

### 立即使用 BM25

延后，直到语料或真实场景首先证明内部搜索有必要，然后再证明元数据感知的词法匹配不够用。

### 从二进制导出完整的 Agent Skill

被否决。它会重建本设计要移除的重复手册和宿主格式耦合。

## 待决事项

一次性交付要求把可以现在决定的事项当场拍板，只把真正依赖实测的留给实现 commit 或发布后信号。

已拍板：

1. 指南命令使用复数 `guides`，与内容为集合一致；`linear guides` 是列表别名。
2. 零参数导航内容与字节预算已随 commit 3 定稿（根导航 1,325 字节；第一阶段基线表中的 1,683 字节为定稿前测量）。
3. Issue delivery manifest v1：Comment 上传文件接受任意本地文件；Attachment 支持 `url` 与本地文件两种输入，复用现有 `issue attach` 的上传路径；IssueRelation 的类型词表与 `issue relation add` 一致（blocked-by 由 CLI 反转为上游的 blocks）。既有集合项的修改与删除留给发布后信号。
4. delivery 命令定名 `linear issue plan` 与 `linear issue apply`，动词直接挂在 issue 域下，与 create/update 风格一致；不设 `delivery` 名词层级。
5. checkpoint 默认写在 manifest 同目录（`<manifest>.checkpoint.json`），对接手者可见、可 grep、可随 manifest 一起交接；不放隐藏缓存目录。
6. 外部 Skill 发布不需要单一激活 Skill 之外的同步机制：skills#219 一次替换，skillshare sync 即 Live。
7. authoring 与访问默认指南优先：判断类内容一律进 `issue-authoring` 指南；新命令只为当前无法机器查询的现场事实而设，`auth whoami` 与 `version --json` 已覆盖的不新增 doctor。commit 7a 的盘点只能以具体缺口推翻该默认，不能反向把判断做成命令。
8. 上下文错误的指南链接本次发布不做：四个已知陷阱由指南承载，错误消息保持干净；是否恢复由发布后信号决定。

没有决策空间、只有验证动作的：

9. 静态文本导入是否通过每一项发布诊断——commit 5 开工时直接实验；回退方案是生成的资源模块。（已验证：静态导入通过全部检查与发布诊断，回退方案未启用。）
10. Linear 的 Markdown 等价改写清单——commit 11 内以实测往返采样补回归；无法安全规范化的差异直接展示给调用者，不判为失败。（已完成：七种实测形态各带真实样本回归，见交付记录验证各轮。）

留给发布后信号或组织决策：

11. 内部搜索、文件系统投影与 `guides export`。
12. Jihuanshe 受管主机是保持 Rotom 所有，还是有意迁移到直接 mise；这必须与 Rotom 契约一起决定，而不能只在本仓库决定。
