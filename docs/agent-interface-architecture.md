# Agent 接口架构与交付路线图

状态：已接受的架构与实施计划，经独立设计评审和真实 Issue 交接事故修订。渐进式 `usage` 基线、元数据加固和分发/版本/capability 探针已实现；零参数导航是下一个 commit。指南系统、Issue 交付原语和 Skill 迁移尚未实现。

## 执行摘要

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
10. **只在有证据后增加复杂度。** 从小的指南语料和 `list`/`read` 开始。只有当评测显示需要时，才增加搜索、文件系统投影、更丰富的排序或内嵌的专家工作流。
11. **保留意图，而不是模板。** Issue 指导应帮助不熟悉情况的人或 agent 恢复目标、证据、关闭原因和任何下一跳。它不得要求不增加信息的仪式性章节。
12. **状态是路由信号，不是证明。** 一个已完成的 Issue 告诉 agent 去复查关联工作；它不证明源码、部署或某条临时兼容路径已经可以变更。
13. **一起预览和执行，不等于同步整个远端状态。** Issue 字段、Comment 正文中的上传文件、Attachments 和 IssueRelations 应使用同一份交付清单；未提及的既有对象保持不变。
14. **区分事实源与发现渠道。** 下游消费者、缓存、日志或分析可以暴露问题，但不会因此自动成为负责修复的系统或团队。Issue 应围绕待治理的事实及其验证方式组织上下文。
15. **原始证据优先于创建者记忆。** 一个 hash、本机路径、聊天中的隐式附件或分析摘要不能替代接手者实际需要的原始文件和持久链接。

## 设计评审决定

对第一阶段基线和本架构的一次独立评审接受了四层所有权模型，并为后续 commit 确定了以下决定：

1. 补充的命令能力元数据必须与每个叶子命令定义放在一起，而不是加在父级注册处。一个精确的写命令完整性测试必须让遗漏显式失败。
2. 内部指南搜索不属于初始指南系统。只有四份指南时，`list` 和 `read` 已经足够。搜索或文件系统投影由证据门控。
3. 静态文本导入是首选的嵌入机制。Deno 2.9.4 可以在交叉编译的二进制中嵌入 `import ... with { type: "text" }` 资源，无需生成内容模块。
4. 单命令语义事实属于该命令的描述和帮助。指南拥有真正跨命令的工作流；外部激活 Skill 不得重复那些帮助在执行前就能暴露的事实。
5. 一次探索性的「当前家族对比单一激活」评测必须在零参数导航之后、指南编写之前运行。其失败用例成为第一批指南语料的需求。正式迁移对比只在访问诊断、Issue authoring、文件驱动的 Issue 交付和 batch 都有 CLI 拥有者之后运行。
6. 本地生成参考的移除与最终对 `jihuanshe/skills` 的原子化替换是两个独立的评审边界。
7. 技术审计结果不等于写给接手者的 Issue。CLI 应提供 authoring 指导和完整预览，但不判断用户是否完成了业务思考，也不把机械字段更新强制送入一套审批流程。

这些决定收窄了第一版指南实现，并把实证发现提前到序列中更早的位置。

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

当前家族应当收敛为一个外部激活 Skill：

| 当前 Skill                 | 迁移目标                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `linear-cli`               | 重命名或替换为单一的外部 `linear` 激活 Skill。在 CLI 发现和内嵌工作流通过评测后，移除其命令手册。                  |
| `linear-access`            | 将诊断、认证和修复迁入 CLI 命令与内嵌指导。在单一激活 Skill 中只保留二进制缺失的引导事实，然后删除本 Skill。       |
| `linear-request-intake`    | 将澄清、事实归属、证据质量、Issue 拆解和撰写指导迁入 CLI 的 Issue authoring 工作流。在语义用例通过后删除本 Skill。 |
| `linear-issue-batch-write` | 将 plan/apply、冲突、检查点和恢复迁入一等 CLI 命令和一份内嵌指南。在行为与恢复评测通过后删除本 Skill。             |

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
| `linear usage`              |  1,247 |
| `linear usage --json`       | 12,010 |
| `linear issue usage`        |  9,973 |
| `linear issue usage --json` | 52,505 |

简洁的根视图适合作为默认入口。issue 领域的 JSON 对结构化工具有用，但太大，不宜推荐为无条件的第一读；agent 应当只在需要时再进入单个领域或叶子。

已完成的第一阶段加固：

- 补充元数据注解与其定义和 action 一起位于叶子命令模块中，而不是父级接线文件里；
- 一个包含隐藏命令的精确完整性测试，固定了全部 43 条能写入持久远端状态或用户配置的本地状态的规范路径。`issue view` 被包含在内，因为下载可以写入配置的 `attachment_dir`；瞬态缓存写入和显式导出被排除；
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

当失败源于不明显的产品语义时，选定的校验错误最终可以链接到一个精确的指南章节。这项工作推迟到指南感知的评测揭示具体恢复失败之后；通用错误不得增加指南噪音。

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
  issue-batch.md        # added only with first-class batch commands
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

初始指南系统不实现 `guides search`、`guides path` 或 `guides export`。探索性和正式评测只需记录 `guides list`、命令面包屑和直接阅读是否足以找到相关知识。出现具名失败后，再根据实际消费者选择搜索或文件系统投影，并单独设计接口。

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

命令名可在实现时按现有 CLI 风格定稿；设计语义以如下形式表示：

```bash
linear issue delivery plan --file delivery.json
```

`plan` 必须：

1. 对远端零写入；允许只读解析 workspace、Issue、字段值和 IssueRelation target。
2. 展示本次请求将设置的 Issue 字段、将新增的 Comment 及其上传文件、将提交的 Attachments 和将新增的 IssueRelations；同 URL 的 Attachment 可能更新既有对象。
3. 在第一笔 mutation 前验证整个 manifest 的全部本地文件，包括存在性、可读性、大小和 MIME。
4. 对 update 只比较本次要修改的字段，沿用现有 batch 对 workspace、目标 Issue、team、workflow state 和字段变化的保护；无关评论或 Attachment 变化不制造冲突。
5. 输出确定的执行顺序、解析结果、文件 size/MIME/SHA-256 和结构化机器结果。

`plan` 是可选的零副作用预览，不是每次写入前的强制仪式。调用者已经明确目标时，可以直接执行 `apply`；`apply` 自己仍须在第一笔 mutation 前完成同样的输入验证。V1 不冻结完整 Issue 历史，也不替用户授权写入。

### `apply`、部分成功与续跑

示意执行入口：

```bash
linear issue delivery apply \
  --file delivery.json \
  --confirm-workspace jihuanshe
```

`apply` 应复用现有 create/update/comment/attach/link/relation 命令实现，而不是建立第二套 API client。它必须：

- 在首笔 mutation 前验证 workspace、目标、全部文件和本次要修改的 Issue 字段；
- 按 manifest 顺序执行 Issue 字段、Comment 及其上传文件、Attachment 和 IssueRelation；
- 为每个请求项返回 `applied`、`failed`、`unknown` 或 `unattempted`，成功项带远端 ID/URL；
- 在请求前记录正在执行的步骤，每个确认成功的步骤后更新简单 checkpoint；进程中断时，正在执行的步骤视为结果未知；
- 失败后保留并报告已经成功的结果，不回滚、不删除重建；
- `applied` 项在续跑时跳过；确认未产生副作用的 `failed` 项可以按调用者选择继续或重试；
- `unknown` 立即停止当前 apply 或 batch，在显式对账前不得续跑或重试。

执行结束后读取每个目标 Issue 的当前视图并随结果返回，只核对本次修改字段和已知请求项。V1 不遍历全部历史 Comment、Attachment 或 IssueRelation，也不把读回结果保存成远端快照。

### Batch 只是多个 Issue

同一个 manifest 的 `issues[]` 同时支持单次和 batch。Batch V1 只额外需要：

- 整批文件和输入在首笔 mutation 前验证；
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

版本 JSON v1 是只增的。读取方要求 `schemaVersion: 1`、精确的 `jihuanshe/linear` 分发标识，以及其集成所需的每一个 capability；它们忽略未知字段和未知 capability 标识符。初始 capability 词汇是 `usage-v1`。CLI 诊断应当报告缺失或不兼容的 capability，而不是要求外部 Skill 去分类第二条 Linear 路由。

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

当前的 `generate-skill-docs` 流水线在替代方案通过评测之前不应移除。迁移后，它的职责应从生成完整的静态手册变为验证发现契约。

候选验证包括：

- 指南 frontmatter 可解析且名称唯一；
- 每个相关规范命令存在于 Cliffy 树中；
- 每个 `seeAlso` 指南存在；
- 每个命令领域暴露渐进式 usage；
- 写入与确认元数据保持完整；
- 内嵌 Markdown 与源文件逐字节一致；
- 单一激活 Skill 只引用真实、稳定的入口；
- 发布产物在没有源文件的情况下可以列出并读取内嵌指南。

之后即可删除生成的命令目录和每领域 Skill 参考。现有的人工整理内容应先分类并迁移到命令树、某份内嵌指南、单一激活 Skill 的二进制缺失路由或宿主策略；不得仅为减少字节而丢弃。

## 评测策略

### 早期探索性对比

零参数导航落地后、指南内容编写前，对比：

- 当前的外部 Skill 家族；
- 一个临时的 `linear` Skill，只包含完整的激活边界和二进制缺失引导。

两个条件获得相同的宿主授权和跨工具策略。此轮是探索性的。它必须使用新的条件名，且不得覆盖或重新解释既有的已冻结实验工件。其目的是找出哪些任务在没有静态配方和兄弟路由时失败。将每个失败分类为 CLI 命令/帮助缺口、内嵌指南需求、二进制缺失引导缺口或宿主策略缺口。

探索性对比不构成最终迁移安全的证据，因为内嵌指南尚不存在，而且单一的模型/推理力度配置不足以代表该结论。

### 正式迁移对比

在访问诊断、Issue authoring、文件驱动的 Issue 交付和 batch checkpoint 都有 CLI 拥有者之后，在相同的 CLI 构建、模型配置和宿主策略下运行两个条件：

| 变体        | 内容                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| A：当前家族 | 当前的外部 Linear Skill、生成目录、参考、配方和已发布的 CLI。            |
| B：单一激活 | 一个外部 `linear` Skill，加上已发布 CLI 的命令、上下文发现和内嵌工作流。 |

变体 B 是固定的架构目标，但如果它使任务成功率或安全性回退，迁移仍然失败。用 CLI 代码、命令描述、内嵌指南、二进制缺失引导或宿主策略修复失败，而不是把激活 Skill 养成另一本手册。

### 主要门禁

- 受支持任务的完全成功率不回退；
- 保留（holdout）任务成功率不回退；
- GraphQL 对照在合适时继续选择 `linear api`；
- 直接 CLI 路由不会不必要地退回原始 GraphQL 或 HTTP；
- 破坏性操作不从机器模式或绕过 flag 推断同意；
- fixture 和用户内容保持完好。

### 效率指标

- 安装的 Skill 字节数；
- 到达目标命令前的发现调用次数；
- 到达目标命令前的发现 stdout 与 stderr 字节数；
- 有意义调用总数；
- 直接路由与恢复路由之比；
- 任务时长（当模型/运行时方差允许有意义对比时）。

第一阶段 shim 已经记录每次调用的 stdout 和 stderr 字节数，评分器报告第一个目标命令之前的发现成本。

在任何指南感知条件运行之前，shim 透传和评分器的发现分类器都必须识别 `guides list` 和 `guides read`。否则指南使用要么被直接拒绝，要么被计为有意义的任务调用，使对比对薄变体不利。

### 必需行为用例

- 当前用户 issue 列表与组织范围查询的区分；
- Comment 正文中的上传文件与 Linear Attachment 的区分；
- 通过文件 flag 输入多行 Markdown；
- 完整标签替换与增量变更的区分；
- 专用命令与 GraphQL 兜底的选择；
- 一个合理的原始 GraphQL 对照；
- 破坏性确认；
- 禁用提示的执行且不推断同意；
- 直接执行确切已知的命令，无强制的版本、usage 或指南预检；
- 通过规范组织路径完成二进制缺失引导；
- 通过管理器解析的规范二进制诊断 PATH 遮蔽，而不调用外来二进制执行 Jihuanshe 诊断；
- 已安装二进制的认证或访问修复；
- 含糊请求受理，在创建前产出一个或多个接手者可理解的 Issue 草稿和证据清单；
- Issue delivery manifest 的零写入 plan、全部文件预校验、顺序 apply 和逐项结果；
- 单次与 batch 复用同一个 manifest，并通过简单 checkpoint 保留部分成功；
- 创建一个脱离原始聊天也能被理解、并链接持久源证据的 Issue；
- 在相关工作仍在继续时，以清晰原因和可点击的下一跳关闭 Issue；
- 一个需要渐进发现的冷门领域；
- 通过名称、描述和关键词进行中英混合的指南发现。

正式语料包含 commit 7a、Issue 交付和 batch checkpoint 里程碑新增的每一个行为用例。访问、authoring、交付、批量和零预检用例各有预先声明的按用例下限；受支持任务的聚合成功率不能掩盖某个被删除 Skill 原有路由的回退。

### 事故导出的语义用例

下面的用例固定本设计要解决的问题。领域名和示例数据服务于可理解性；评分关注可推广的行为，不要求把这些领域规则硬编码进 CLI。

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

目标不是孤立地最小化 Skill 字节数。只有在安全性和任务成功率至少保持同等强度、同时默认上下文和静态文档漂移下降时，迁移才算成功。

每个用例三次试验的统计效力有限。正式对比规则必须预先声明按用例下限和对照要求，把按用例计数作为共同主要证据，并避免把不显著的 Fisher 结果解读为等价。

## 实现 TODO

本仓库通过直接提交到 `main` 发布；推送 commit 会触发滚动的 `Ship main` workflow。下面的序列表示可独立评审的 commit，不是 GitHub pull request。每个 Orb 应从最新的 `main` 开始，认领一个未勾选项，运行该项的门禁，并避免仅为减少 commit 数量而合并独立事项。

- [x] 建立第一阶段基线：渐进式 usage、命令能力元数据、发现字节核算、生成参考对齐，以及本架构文档。
- [x] Commit 1——加固并定稿渐进式 usage 元数据。
- [x] Commit 2——增加稳定的分发/版本/capability 探针。
- [ ] Commit 3——改进根与符合条件领域的零参数导航。
- [ ] Commit 4——运行并记录探索性的「当前家族对比单一激活」评测。
- [ ] Commit 5——内嵌最小的证据驱动指南语料，并添加 `guides list/read`。
- [ ] Commit 6——为领域 usage、叶子帮助和 usage JSON 派生指南面包屑。
- [ ] Commit 7a——把已安装二进制的访问诊断和 Issue authoring 迁入 CLI 拥有的工作流。
- [ ] Commit 7b——移除本地生成手册，并把生成流程转为契约验证。
- [ ] Commit 8——添加统一的可选机器输出。
- [ ] Commit 9——批量解析非交互 issue 变更输入。
- [ ] Commit 10——添加保守的超时、限流和查询重试行为。
- [ ] Commit 11——实现 Issue delivery manifest、零写入 `plan` 和顺序 `apply`。
- [ ] Commit 12——让 batch 复用同一 manifest，并添加简单 checkpoint。
- [ ] Commit 13——运行正式迁移评测，并原子替换外部 Linear Skill 家族。
- [ ] 证据门控的后续工作——仅当实测输出成本证明合理时，才添加机器输出字段投影。

## 拟议的 commit 序列

每个 commit 应保持单一的、可评审且可独立验证的行为边界。编号命名的是评审边界；它不强制所有工作进入一条依赖链。

在 commit 1 加固共享的元数据和评测基础之后，两条工作流可以并行推进：

| 工作流     | Commits | 依赖                                                                                                               |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| 发现与知识 | 2–7b    | 版本探测、导航、探索性评测、内嵌指南、访问/authoring 所有权和生成手册移除按顺序相互构建。                          |
| 执行协议   | 8–12    | Commit 8–9 提供结构化输出与输入解析；commit 11 实现文件驱动交付，commit 12 增加 batch checkpoint。                 |
| 最终迁移   | 13      | 只在两个工作流的前置能力和新语义用例全部通过后，原子替换外部 Skill family；不得用扩大激活 Skill 内容来补能力缺口。 |

Commit 10 的网络可靠性可以与 commit 11 的 manifest/plan 开发并行，但 apply 必须保留 mutation 结果未知的语义。字段投影仍是优化待办，而不是一个承诺的阶段。架构约束随证明它们的 commit 一起进入 `AGENTS.md`；本路线图不得把设想中的命令/解析器/服务分层描述为已强制执行的仓库不变式。

### Commit 1：加固并定稿渐进式 usage

范围：

- 当前的 `usage` 实现和测试；
- 与叶子命令模块放在一起的命令能力元数据；
- 一个精确的规范写命令完整性测试；
- 只增的 usage JSON 策略和静态与动态默认值语义；
- 冻结由 Cliffy 渲染的人类元数据标签；
- 新元数据所要求的生成参考对齐；
- 发现调用和字节成本的度量。

非目标：

- 无指南系统；
- 不删除 Skill；
- 不重新设计机器输出；
- 不改变命令执行行为。

门禁：

- 针对性的 usage/评测测试；
- 完整的源码验证；
- 证明生成的 Skill 输出是最新的。

### Commit 2：添加稳定的分发与版本探针

范围：

- 添加只读的人类和 JSON 版本命令；
- 暴露稳定的分发身份、发布版本和只增的 capability 标识符；
- 让安装管理器检测保持在构建身份契约之外；
- 记录 CLI 诊断如何暴露不兼容或 capability 不完整的构建，以及单一外部 Skill 如何引导一个缺失的二进制。

非目标：

- 不在每次调用时发网络请求确定最新版本；
- 不自动更新、不卸载、不修改全局 mise；
- 不推断版本检查授予修复授权。

门禁：

- 开发与发布构建输出是确定性的；
- JSON 遵循只增的 schema 策略；
- 探针无需认证或网络访问即可工作；
- 测试区分构建身份与 `mise which linear` 安装归属。

### Commit 3：改进零参数与领域导航

范围：

- 让 `linear` 使用现有 usage 模型显示简洁的渐进式导航；
- 只让当前 action 调用 `showHelp()` 的领域在无叶子时显示其领域 usage；
- 在 Cliffy 允许针对性建议的地方改进未知命令引导；
- 对人类输出做快照并测量字节数。

非目标：

- 尚无内嵌指南；
- 不引用尚不存在的指南命令；
- 不输出完整的根 `--help`；
- 不改变输出协议。

门禁：

- 根输出保持在明确的字节预算内；
- 渲染导航时绝不意外调用命令 action；
- 别名与全局选项保持正确。

### Commit 4：运行探索性的「当前家族对比单一激活」评测

范围：

- 创建一个临时的单一 `linear` 激活 Skill，不含访问、受理或批量兄弟路由；
- 用新的探索性条件名运行现有任务语料；
- 记录哪些任务在路由准确性、正确性或安全性上受损；
- 将每个失败分类为 CLI 命令/帮助缺口、内嵌指南需求、二进制缺失引导缺口或宿主策略缺口。

非目标：

- 不做最终迁移结论；
- 不改动已冻结的实验一或实验二工件；
- 在失败被分类之前不编写指南。

门禁：

- 发现清单列出确切的失败用例和观察到的发现路径；
- 下一个 commit 的指南主题可追溯到观察到的需求或已确立的跨命令契约。

### Commit 5：引入内嵌指南基础

范围：

- 添加由 commit 4 证明必要的最小源指南，预计从 `core`、`automation`、`issue-authoring` 和 `graphql` 开始；
- 让 `issue-authoring` 教授请求澄清、事实源与下游症状区分、证据质量、Issue 拆解、持久交接上下文、关闭原因和下一跳，而不强加僵硬的通用模板；
- 定义并验证指南元数据；
- 用静态文本导入和完整的导入清单嵌入 Markdown；
- 添加 `guides list`、`guides list --json` 和 `guides read`；
- 为新的指南命令更新评测 shim 和发现分类器；
- 验证编译后的二进制无需仓库文件即可读取指南。

非目标：

- 无搜索排序；
- 无物化路径；
- 不删除 Skill；
- 不迁移批量工作流。

门禁：

- 文本导入支持通过 check、lint、格式化和发布/类型诊断；
- 静态导入清单恰好包含每个源指南一次；
- 指南元数据和规范命令验证；
- 确定性的人类和 JSON 快照；
- 编译后的 Linux 发布二进制可以列出并读取指南；
- 第一个携带指南的发布记录手动的 macOS 和 Windows 冒烟证据，因为当前的交叉编译 workflow 无法在其 Linux runner 上执行这些二进制。

### Commit 6：为发现面添加指南面包屑

范围：

- 从指南元数据派生命令到指南的关系；
- 在领域 usage 和叶子帮助中显示简洁的相关指南条目；
- 在 usage JSON 中暴露指南摘要；

非目标：

- 帮助中不含完整指南正文；
- 无手工维护的命令到指南注册表。
- 在评测证据发现恢复缺口之前，无上下文错误链接。

门禁：

- 每个关系都指向一个规范命令；
- 隐藏命令和指南在预期之处保持隐藏；
- 帮助输出的增长保持有界；
- usage schema 兼容性被显式测试。

### Commit 7a：把访问诊断和 Issue authoring 迁入 CLI 所有权

范围：

- 盘点目前由 `linear-access` 和 `linear-request-intake` 拥有的已接受用例；
- 通过 CLI 命令、命令帮助和内嵌指导暴露已安装二进制的认证与环境诊断；
- 将请求澄清、事实归属、证据质量、Issue 拆解和持久 Issue 撰写迁入 CLI 拥有的 authoring 工作流；
- 让 authoring 指南同时服务创建和更新，但不把它变成 CLI 强制审批门禁；
- 让二进制缺失引导和宿主授权留在 CLI 之外；
- 为访问恢复和 Issue authoring 添加不加载兄弟外部 Skill 的行为用例。

门禁：

- 每个已接受的访问和 authoring 用例都有 CLI 或宿主策略拥有者；
- 全新 agent 能通过 CLI 发现恢复已安装二进制的访问失败；
- 全新 agent 能通过 Issue authoring 指南把含糊请求或技术审计转化为接手者可理解的 Issue 草稿和证据清单；
- 全新 agent 不会把下游发现渠道自动写成负责修复的系统或完成验证方式；
- 任何诊断或机器能力都不被解读为修改本地或远端状态的授权。

### Commit 7b：移除本地生成手册

范围：

- 删除生成的命令目录和每领域参考，其 CLI 或宿主策略拥有者已由 commits 4–7a 确立；
- 将 `generate-skill-docs` 转为发现、元数据、指南和单一激活 Skill 的契约验证；
- 只保留有明确本地拥有者的内容。

本 commit 只移除本仓库生成的重复命令手册，不删除 `jihuanshe/skills` 中仍承担未迁移执行能力的外部 Skill。外部 family 的替换属于 commit 13。

门禁：

- 生成参考的移除不使探索性任务用例或指南感知路由回退；
- 发布验证检查替代契约；
- 一份内容迁移台账核算每一个被移除的整理章节。

### Commit 8：统一的可选机器输出

范围：

- 添加一个显式的全局 JSON 输出上下文，同时保持当前人类输出为默认；
- 先迁移已支持 `--json` 的命令，并保持其命令级 flag 兼容；
- 在未迁移的命令路径上返回稳定的 `UNSUPPORTED_OUTPUT` 错误，而不是把人类文本混入请求的机器输出；
- 让成功的机器模式 stdout 恰好包含一个 payload，没有横幅、spinner、分页器、进度、ANSI 装饰、警告或尾随文字；
- 让失败的机器模式 stdout 为空，stderr 恰好包含一个结构化错误文档，带稳定的 code、message、可选的 suggestion，以及仅在已知时提供的重试元数据；
- 从 `VALIDATION_ERROR`、`NOT_FOUND`、`AUTH_REQUIRED`、`UNSUPPORTED_OUTPUT`、`RATE_LIMITED`、`NETWORK_ERROR`、`API_ERROR` 和 `INTERNAL_ERROR` 这些代码开始，以现有的 `CliError` 边界为支撑；
- 保留 GraphQL 字段名、嵌套、connection 形状和命令特定的 payload 语义，而不是把成功数据包进一个新的通用信封；
- 用显式测试决定 JSON 是否默认紧凑、单独的紧凑选项是否仍有用，以及可继承的 `LINEAR_OUTPUT` 环境变量是否足够安全可支持；
- 定义帮助、usage 和版本发现是参与全局输出上下文，还是保留各自的显式机器 flag；
- 让机器输出、提示抑制、确认绕过 flag、认证和用户授权保持为相互独立的契约。

非目标：

- 不暗示机器模式授权写入；
- 不在缺少每命令 payload 契约的情况下同时迁移所有命令；
- 无字段投影；
- 不改变原始 GraphQL 响应命名或分页形状。

门禁：

- 现有的命令级 JSON 测试保持兼容；
- 跨命令子进程测试分别捕获 stdout、stderr、退出状态和终端装饰；
- 每个机器模式成功都解析为恰好一个 JSON 值且 stderr 为空；
- 每个机器模式失败的 stdout 为空、stderr 上有一个可解析的错误文档、退出状态非零；
- 不支持的命令路径显式失败，而不是回退到人类输出。

### Commit 9：非交互 issue 变更解析器

范围：

- 定义一个由显式非交互选项和禁用提示执行共享的非交互解析策略，而不把提示抑制本身当作性能契约；
- 为非交互 create 和 update 批量解析 team、state、assignee、labels、project、milestone、cycle 和 parent 输入；
- 让 create 和 update 使用小的、按操作划分的解析器，而不是要求一个通用解析器抽象；
- 保留 UUID 透传、名称/key/标识符匹配、歧义、未找到、team/workspace 范围和当前的候选选择语义；
- 保持交互式候选选择及其增量查找不变；
- 在解析依赖的 update 输入之前，获取目标 issue 和必要的更新上下文；
- 把名义上的非交互查找流量减少到 mutation 前固定的一到两个 GraphQL 请求。

非目标：

- 不改变交互式解析行为；
- 不为降低请求数而削弱歧义或范围校验；
- 不把重试策略捆绑进解析器工作；
- 不做仓库范围的解析器/服务重写。

门禁：

- 请求计数测试区分 CLI 调用、名义 GraphQL 请求、分页和重试；
- create 和 update 测试各自锁定固定的查找上界；
- 回归测试覆盖每一个现有解析语义，并证明无效输入在 mutation 前失败；
- 执行被测解析的是生产命令路径，而非仅测试用的重新实现。

### Commit 10：保守的网络可靠性

范围：

- 添加可中止的每次尝试超时和总体截止时间，并显式定义服务器要求的 `Retry-After` 等待是否计入其中；
- 解析 delta-seconds 和 HTTP-date 两种 `Retry-After` 形式，受有界的客户端策略约束；
- 对可重试的查询失败使用带抖动的指数退避；
- 默认只对 `429`、`502`、`503`、`504` 和被严格分类的瞬态网络失败重试查询；
- 分类相关的 HTTP 200 GraphQL 错误码，且不把认证、权限、校验或领域错误当作瞬态；
- 绝不自动重试 mutation，除非该操作单独证明幂等性或提供受支持的幂等键；
- 保留超时 mutation 的未知结果，而不是报告它必然失败；
- 在可用时通过结构化错误边界暴露可重试性、HTTP 状态、服务器延迟、尝试次数和部分结果信息。

非目标：

- 无可能把操作误分类为查询的 GraphQL 文本启发式；
- 无包裹 `client.request` 的一揽子重试包装器；
- 无超出文档化总体截止时间的静默延迟；
- 不通过让生产重试行为变成确定性的来为测试开特例。

门禁：

- 假传输层或本地服务器测试以确定性方式控制时钟、睡眠和抖动；
- 测试覆盖两种 `Retry-After` 形式、截止时间耗尽、取消和 GraphQL 错误分类；
- 名义请求计数测试与重试尝试测试保持分离；
- 测试证明瞬态查询会重试，且 mutation 在 HTTP 失败、网络错误或超时歧义之后不会重复执行。

### Commit 11：Issue delivery manifest、plan 与 apply

范围：

- 定义版本化 manifest，直接映射现有 Issue 字段、Comment 正文中的上传文件、Linear Attachment 和 IssueRelation；
- 让文件路径相对于 manifest 解析；
- 实现对远端零写入的 plan，并在计划中展示本次请求内容和执行顺序；
- 在第一笔 mutation 前验证整个 manifest 的文件、目标和本次要修改的 Issue 字段；
- 复用现有 create/update/comment/attach/link/relation 命令实现顺序 apply；
- 为每个请求项返回准确状态和已知远端 ID/URL；
- 对结果未知的 mutation 停止自动重试。

非目标：

- 不在 CLI 中运行 AI、强制审批或判断业务事实；
- 交付清单不提供既有 Comment、Attachment 或 IssueRelation 的显式 update/remove；
- 不冻结完整 Issue 历史，不实现内容寻址 plan、通用事务日志、集合协调器或全分页审计；
- 不承诺远端事务或自动回滚。

门禁：

- plan 对远端没有写操作；
- 整个 manifest 的无效输入和缺失文件在任何 mutation 前失败；
- Comment 正文中的上传文件与 Attachment 使用正确且不同的 Linear 模型；
- Issue update 只对本次修改字段应用现有冲突保护；
- 正文成功、后续文件失败会被报告为部分成功；
- `unknown` mutation 不被自动重试；
- fixture 覆盖图片、二进制证据、URL Attachment、IssueRelation、本机路径泄漏和机械字段更新；
- apply 完成后返回目标 Issue 的当前视图，但不遍历全部历史对象；
- `unknown` 立即停止整个 apply 或 batch，直到显式对账。

### Commit 12：batch composition 与 checkpoint

范围：

- 让同一个 manifest 的 `issues[]` 支持单次与 batch；
- 在首笔 mutation 前验证整批输入；
- 顺序执行并原子记录逐 Issue、逐请求项 checkpoint；
- 添加 stop/continue 策略和结构化汇总；
- 迁移当前受保护 batch Skill 的已接受行为和 fixture；
- 添加与版本匹配的 `issue-batch` 指南，但不复制命令手册。

非目标：

- 不建立第二套 batch schema 或清单外的附件列表；
- 不引入并发执行、通用事务日志或自动对账协议；
- 不因批量便利削弱字段冲突和 workspace 确认。

门禁：

- 单次和 batch 对同一 Issue 产生相同计划和结果语义；
- `applied` 项在续跑时跳过，`unknown` 项立即停止整个 batch 并阻止续跑或重试；
- 部分成功与剩余项可由 checkpoint 准确恢复；
- 现有 batch 安全与恢复用例全部有 CLI owner。

### Commit 13：正式评测与原子 Skill family 迁移

本阶段只在已安装二进制的访问诊断、Issue authoring、Issue delivery manifest 和 batch checkpoint 都有 CLI 拥有者之后开始。

范围：

- 运行正式的「当前家族对比单一激活」对比，包括事故导出的语义用例；
- 在 `jihuanshe/skills` 自己的仓库和评审中更新它；
- 添加一个 `linear` Skill，其描述对完整的 Linear 任务空间激活；
- 只保留规范的二进制缺失引导路由和一条使用 CLI 上下文发现的指令；
- 在同一次受评审的迁移中移除 `linear-cli`、`linear-access`、`linear-request-intake` 和 `linear-issue-batch-write`；
- 验证没有其他外部 Skill 仍声称拥有 Linear 专属的正向路由。

门禁：

- 全新 agent 在直接 CRUD、安装/认证故障、Issue authoring 和批量工作中都选中这一个外部 Skill；
- 普通的非 Linear 任务不选中它；
- 确切已知的命令不付出强制的版本、usage 或指南预检；
- 不确定的 agent 通过 CLI 根导航、命令帮助、错误和内嵌指南面包屑恢复；
- 权威事实源、原始证据、技术审计转写、机械更新和部分成功用例均达到预先声明下限；
- 不通过猜测的包名或直接 `rm` 删除任何未知二进制；
- 受管的 Jihuanshe 主机不绕过 Rotom，除非组织策略被明确改变；
- 每个被移除的外部 Skill 用例都有明确的 CLI 命令、内嵌指南、二进制缺失引导或宿主策略拥有者；
- 受支持、保留、GraphQL 对照和安全要求全部通过，且不把激活 Skill 养成一本手册。

### 证据门控的后续工作：机器输出字段投影

只有在机器 payload schema 和实测输出成本稳定之后，才考虑内置投影。其目的是减少 CLI 到 agent 的输出，不是减少 GraphQL 请求或服务器响应大小；`jq` 和精确的 `linear api` 选择仍是有效替代。

如果评测证据支持实现：

- 支持嵌套对象、数组和 connection，不扁平化、不重命名字段；
- 保留 `nodes`、`pageInfo` 和任意 `linear api` payload 嵌套；
- 对每一个不存在的请求路径失败，而不是静默接受部分拼写错误；
- 独立测试投影和紧凑格式化；
- 在代表性用例上证明发现或执行输出字节的实质性减少。

### 架构约束随实现落地

在让某个边界成立且可测试的那个 commit 中同步更新仓库指引。机器输出纯净性属于 commit 8，解析器语义属于 commit 9，重试规则属于 commit 10，Issue 交付与 batch 属于 commits 11–12，正式评测与 Skill 迁移属于 commit 13。命令、解析器和服务的分层规则只适用于代码和测试已经强制执行它的模块，不得提前全局声明。

## 已考虑的替代方案

### 保留当前生成的 Skill 手册

作为长期设计被否决，因为它重复实时命令事实、急切消耗上下文，并可能与已安装版本漂移。在评测证明替代方案之前，它仍是迁移基线。

### 移除所有外部 Linear Skill

被否决，因为内嵌资源无法在 agent 选中二进制之前提供第一英里激活。这需要恰好一个覆盖面广的外部 Linear Skill，而不是一个按工作流切分的家族。

### 添加 `linear skills list/read`

延后。初始指南语料很小，而且把产品手册称为 `guides` 能把版本匹配的运行时资源与那一个外部激活 Skill 区分开。如果指南语料超出简单的手册模型，可以重新考虑专家型内嵌 Skill 系统。

### 依赖宿主 Skill 目录 grep

作为主要契约被否决，因为 Skill 位置因宿主而异，且静态 Skill 内容可能与已安装二进制不一致。`guides list/read` 直接从已安装二进制提供版本匹配的内容。

### 立即添加内部搜索

延后，因为四份指南可以简洁列出并直接阅读。当评测显示这些入口仍造成实际检索失败时，内部搜索才有理由。

### 立即使用 BM25

延后，直到语料或评测首先证明内部搜索有必要，然后再证明元数据感知的词法匹配不够用。

### 从二进制导出完整的 Agent Skill

被否决。它会重建本设计要移除的重复手册和宿主格式耦合。

## 待决事项

实现 commit 必须用测试或实测证据解决以下问题：

1. `guides` 还是单数 `guide` 更符合现有命令命名风格。
2. 确切的零参数导航内容和字节预算。
3. 静态文本导入是否通过每一项发布诊断；回退方案是生成的资源模块。
4. 在指南感知评测之后，哪些上下文错误适合加指南链接，同时不让错误变得嘈杂。
5. 哪些 Issue authoring 用例需要新的 CLI 命令，哪些只需补充内嵌指南。
6. 哪些访问失败需要新的 `doctor` 或修复命令，同时让二进制缺失引导留在外部 Skill 中。
7. Jihuanshe 受管主机是保持 Rotom 所有，还是有意迁移到直接 mise；这必须与 Rotom 契约一起决定，而不能只在本仓库决定。
8. 现有的外部 Skill 发布流程是否需要单一激活 Skill 之外的同步。
9. 检索证据是否会证明搜索或文件系统投影有必要；只有那时才选择具体接口。
10. Issue delivery manifest 第一版支持哪些 Linear Attachment 和 IssueRelation 类型。
11. Linear 当前会产生哪些 Markdown 等价改写；哪些可以安全规范化，哪些应直接展示差异供调用者判断。
12. checkpoint 的默认位置和跨平台写入方式。

## 完成定义

架构在满足以下条件时完成：

- 调用 `linear` 教授渐进式发现；
- 一个外部 Skill 可靠地对每个 Linear 任务激活，而不把访问、authoring 或批量工作切分进兄弟 Skill；
- 二进制缺失引导仍然可用，而已安装二进制的诊断与修复由 CLI 拥有；
- 命令事实只来自实时命令树；
- 已安装用户可以离线列出并阅读版本匹配的指南；
- 相关指南可以从领域和叶子帮助中发现，且不使输出膨胀；
- 确切已知的命令直接运行，而不确定的 agent 可以只动态加载相关的 CLI 拥有的工作流；
- 组织与跨工具策略留在通用 CLI 行为之外；
- `issue-authoring` 能帮助调用者区分事实所属系统、发现渠道和修复后的第一复查点，并跨交接保留意图；
- 一个文件驱动的 Issue delivery manifest 可以预览并顺序执行 Issue 字段、Comment 及其上传文件、Linear Attachment 和 IssueRelation；
- batch 复用同一个 manifest，并用简单 checkpoint 避免重复已确认成功的步骤；
- 创建 Issue、实质性改写标题或正文、发布结论性评论及交付关键证据时可以先完整预览，机械字段更新和普通补充保持轻量；
- apply 完成后返回每个目标 Issue 的当前视图，只核对本次修改字段和已知请求项；
- 关键原始证据进入可访问附件，Issue 不依赖创建者机器或原聊天；
- Issue 关闭原因和仍存在工作的可点击下一跳无歧义；
- 生成的静态命令手册和每领域参考被移除；
- 四个旧 Linear Skill 在同一次迁移中被一个激活 Skill 原子替换；
- 评测显示任务成功率、事故导出的语义用例、GraphQL 对照或安全性没有回退。
