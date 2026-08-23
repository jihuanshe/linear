# Linear CLI

一个面向人类和 AI Agent、理解 Git 与 Jujutsu 的 [Linear](https://linear.app/) 命令行界面。

无需离开终端，即可用它查看 Issue、开始工作、更新 Linear 状态、创建 Pull Request，并自动化 Linear 工作流。

> [!IMPORTANT]
> 本仓库 [`jihuanshe/linear`](https://github.com/jihuanshe/linear) 是 [`schpet/linear-cli`](https://github.com/schpet/linear-cli) 的下游 fork。
>
> 原项目由 [Peter Schilling](https://github.com/schpet) 及其贡献者创建。它的 CLI 设计、Git 与 Jujutsu 集成、交互式工作流以及大部分命令界面构成了本 fork 的基础。
>
> 本 fork 由 [Jihuanshe](https://github.com/jihuanshe) 维护，并可能有意与上游产生差异。它专注于可预测的自动化、机器可读输出、明确的 mutation 契约，以及供 AI Agent 安全使用。

本项目不是 Linear 的官方产品，也不隶属于 Linear 或得到其认可。

## 为什么存在这个 fork

上游 CLI 为人类用户提供了高效的终端工作流：

- 从 Git 分支或 Jujutsu 提交 trailer 推断当前 Linear Issue；
- 列出、查看、创建和更新 Linear 实体；
- 开始处理 Issue，并创建或切换到对应分支；
- 携带 Linear 上下文创建 GitHub Pull Request；
- 打开正确的 Linear Web 或桌面视图；
- 以交互方式工作，无需反复切换到 Linear UI。

这个下游 fork 保留了这些工作流，同时让 CLI 更适合作为 AI Agent 和无人值守自动化使用的稳定工具边界。

当前重点包括：

- 使用与 GraphQL 兼容的字段名称和嵌套结构输出结构化 JSON；
- 稳定地以 `{ "nodes": [], "pageInfo": {} }` 形式输出 connection；
- 使用明确的 `--limit` 行为限制分页；
- 让 stdout 只包含机器可读结果；
- 将诊断信息、警告和错误输出到 stderr；
- 为语法、验证和运行时失败提供可预测的退出码；
- 在非交互式管道中不输出颜色、不显示 spinner、不使用 pager，也不泄漏提示内容；
- 通过 `LINEAR_PROMPT_DISABLED=1` 全局禁用提示；
- 对破坏性操作要求显式确认；
- 在替换会造成不必要破坏时，使用增量式 patch 更新；
- 从 `main` 生成滚动发布构建。

它有意**不**提供包办一切的「Agent 模式」。JSON 输出、终端样式、分页、提示和 mutation 授权仍然是相互独立的契约。

## 快速开始

### 使用 mise 安装

安装 `main` 的最新发布构建：

```bash
mise use -g "github:jihuanshe/linear[minimum_release_age=0s]@latest"
linear --version
linear version --json
```

mise 会为 macOS、Linux 或 Windows 选择匹配的二进制。运行时不需要 Deno 或 Node.js。

`linear --version` 保留传统的纯文本版本字符串。`linear version --json` 还会在无需认证或网络访问的情况下，标识 `jihuanshe/linear` 发行版及其增量协议能力。它标识的是构建，而不是该可执行文件由 mise 还是其他管理器管理。

`minimum_release_age=0s` 只对本工具生效。它允许新发布的 `main` 构建立即安装；否则 mise 默认会将新的 GitHub Release 隐藏 24 小时。

Release 使用以下格式的版本号：

```text
0.0.<commit timestamp>-g<short commit>
```

使用 `latest` 跟随已发布的 `main` 构建；需要可复现时则固定到确切版本。

预构建二进制和校验和也可从 [GitHub Releases](https://github.com/jihuanshe/linear/releases/latest) 获取。

### 更新

使用相同的安装方式更新已安装的 CLI：

```bash
linear update
```

对于由 mise 管理的安装，它会运行作用域限定于本工具的 `mise up`，并遵循已配置的版本选择器。只有在确实希望 mise 重写固定选择器时，才使用 `linear update --bump`。对于直接从 GitHub Releases 下载的二进制，`linear update` 会下载匹配的二进制，检查其 SHA-256 校验和，并替换当前可执行文件。

### 认证

在 [Linear 设置](https://linear.app/settings/account/security) 中创建个人 API key，然后运行：

```bash
linear auth login
```

验证当前选中的账户：

```bash
linear auth whoami
linear auth whoami --json
```

环境变量和多 workspace 配置请参阅[认证](docs/authentication.md)。

### 配置仓库

在项目仓库中运行：

```bash
linear config
```

这会创建一个 `.linear.toml`，其中包含默认的 Linear workspace 和 team。

## 人类工作流

```bash
linear issue mine
linear issue query --search "login bug"
linear issue view ENG-123
linear issue start ENG-123
linear issue update ENG-123 --state "In Progress"
linear issue pr
```

当前 Issue 可以从以下信息推断：

- 包含 `eng-123-fix-login` 等标识符的 Git 分支；或
- 当前 Jujutsu 提交或其祖先提交中的 `Linear-issue` trailer。

当 stdin 是终端且提示未被禁用时，交互式命令仍然可用。

## Agent 与自动化工作流

无人值守执行时，禁用所有交互式提示：

```bash
export LINEAR_PROMPT_DISABLED=1
```

此设置会：

- 阻止 CLI 显示提示或从 stdin 读取响应；
- 让参数完整的命令正常继续；
- 让缺少输入或确认的命令明确失败；
- 永远不选择提示的默认值；
- 永远不代表已获得授权；
- 永远不替代 `--force`、`--confirm` 或其他显式 mutation 标志。

只读机器用法示例：

```bash
linear auth whoami --json
linear team list --json --limit 20
linear project list --all-teams --json --limit 20
linear issue query --all-teams --json --limit 50
```

Mutation 应同时指定目标和预期变更：

```bash
linear issue update ENG-123 \
  --state "In Review" \
  --add-label reviewed \
  --json
```

`--add-label` 和 `--remove-label` 等增量选项可以避免替换无关的已有值。

对于破坏性操作，使用 `--help` 展示的命令专用确认契约：

```bash
linear issue delete ENG-123 --confirm
```

不要把 `LINEAR_PROMPT_DISABLED=1` 当作修改或删除 Linear 数据的授权。

## 命令组

| 命令组              | 用途                                       |
| ------------------- | ------------------------------------------ |
| `linear auth`       | 认证与 workspace 凭据                      |
| `linear issue`      | 查询、创建、更新和交付 Issue（plan/apply） |
| `linear team`       | Team、成员、状态和仓库 autolink            |
| `linear project`    | Project 发现与管理                         |
| `linear milestone`  | Project milestone 管理                     |
| `linear document`   | Linear 文档工作流                          |
| `linear initiative` | Initiative 发现                            |
| `linear cycle`      | Cycle 发现与 Issue 过滤                    |
| `linear label`      | Workspace 和 team 标签                     |
| `linear user`       | Workspace 成员发现                         |
| `linear api`        | 执行显式的 Linear GraphQL 操作             |
| `linear guides`     | 版本匹配的工作流指南                       |
| `linear upload`     | 上传用于嵌入 Markdown 的文件               |
| `linear version`    | 查看构建身份和协议能力                     |

此表是精选概览；完整且始终最新的契约以 `linear usage` 为准。对于涵盖描述、带文件的评论、附件和关系的交付，请编写 delivery manifest 并使用 `linear issue plan` / `linear issue apply`；`linear guides read issue-delivery` 记录了该协议。

从已安装的二进制中发现当前命令契约：

```bash
linear version --json
linear usage
linear --help
linear issue --help
linear issue query --help
```

跨命令工作流指南随二进制发布并保持版本匹配：`linear guides list`、`linear guides read <name>`。

## 配置

可以通过环境变量或 `.linear.toml` 提供配置。环境变量优先。

| 设置               | 环境变量                          | TOML key                   |
| ------------------ | --------------------------------- | -------------------------- |
| 默认 team          | `LINEAR_TEAM_ID`                  | `team_id`                  |
| Workspace slug     | `LINEAR_WORKSPACE`                | `workspace`                |
| Issue 排序         | `LINEAR_ISSUE_SORT`               | `issue_sort`               |
| 创建时询问 project | `LINEAR_ISSUE_CREATE_ASK_PROJECT` | `issue_create_ask_project` |
| 默认分配给自己     | `LINEAR_ISSUE_CREATE_ASSIGN_SELF` | `issue_create_assign_self` |
| 版本控制系统       | `LINEAR_VCS`                      | `vcs`                      |
| 下载内嵌图片       | `LINEAR_DOWNLOAD_IMAGES`          | `download_images`          |

提示由独立设置控制：

```bash
LINEAR_PROMPT_DISABLED=1
```

配置文件按以下顺序解析：

1. `./linear.toml` 或 `./.linear.toml`；
2. 仓库根目录的 `linear.toml` 或 `.linear.toml`；
3. 仓库根目录的 `.config/linear.toml`；
4. 平台用户配置目录。

## 附件与公开图片

附件默认仅对 Linear workspace 私有：

```bash
linear issue attach ENG-123 ./screenshot.png
linear issue comment add ENG-123 --attach ./screenshot.png
```

传入 `--public` 会将支持的栅格图片上传到公开的 `public.linear.app` URL：

```bash
linear issue comment add ENG-123 \
  --attach ./screenshot.png \
  --public
```

任何拥有该 URL 的人都可以无需认证访问图片。因此，CLI 要求显式选择此行为。

## Agent Skills

仓库使用标准的 [Agent Skills](https://agentskills.io/) 布局：

- [`.agents/skills/releasing`](.agents/skills/releasing/SKILL.md) 记录本仓库贡献者的发布工作流。

命令事实存在于实时命令树（`linear usage`、`--help`）中，跨命令工作流则存在于内嵌指南（`linear guides`）中，因此这里不再提供生成的 Skill 手册。供 Agent 激活的外部 Skill 由 `jihuanshe/skills` 维护。

Agent 必须使用已安装的 `jihuanshe/linear` 二进制。不要回退到上游 npm 包，因为它提供的命令和自动化契约可能与此 fork 不同。

## 开发

这是一个 Deno 项目。`AGENTS.md` 是开发契约，`deno.json` 是任务来源，`mise.toml` 固定受支持的运行时版本。

```bash
git clone https://github.com/jihuanshe/linear
cd linear
mise install
```

Amp Orb 使用 `.agents/setup` 和 `.agents/resume`，而不是宿主环境的 mise 安装。

开发期间运行源码验证：

```bash
deno task verify-source
```

该任务会运行 GraphQL 代码生成、格式检查、lint、类型检查和所有非 Keyring 测试。

修改命令树或 `docs/guides/` 时，指南测试会根据实时命令树验证 frontmatter、命令引用和导入 manifest。

发布前运行完整的本地发布门禁：

```bash
deno task verify-release
```

向 `main` 提交的 Pull Request 会运行 [`Source gate`](.github/workflows/verify-pull-request.yml)，在合并前执行 `deno task verify-release`。[发布 Skill](.agents/skills/releasing/SKILL.md) 是发布流程。经授权的 `main` 推送会启动 [`Publish Linear CLI rolling release`](.github/workflows/ship-main.yml)：其串行队列最多保留 100 个待处理的 `main` 更新，运行 Linux Keyring 集成测试，构建五个平台，验证并证明资源，然后为每次成功运行发布独立的 GitHub Release。只有仍与当前 `main` head 匹配的任务才会将其 Release 标记为 latest，从而防止较早的排队任务将安装目标回退。源码管理的版本仍为 `0.0.0-dev`；已发布版本来自提交时间戳和 SHA。每个已发布的 GitHub Release 随后都会以相同版本号记录为一个已完成的 Linear Release，并附带指向 GitHub 的链接。

## 上游与致谢

本仓库是 [`schpet/linear-cli`](https://github.com/schpet/linear-cli) 的下游 fork。

原项目由 Peter Schilling 创建。本仓库中的许多功能、命令设计、测试、文档章节和集成由[上游贡献者](https://github.com/schpet/linear-cli/graphs/contributors)创建。

准确的滚动发布构建历史仍可在本仓库的 Git 历史和 GitHub Releases 中查看。

报告问题时：

- 将 fork 特有的自动化、发布、JSON 或安全契约问题报告给 [`jihuanshe/linear`](https://github.com/jihuanshe/linear/issues)；
- 如果问题在未经修改的上游项目中也能复现，可以考虑报告给 [`schpet/linear-cli`](https://github.com/schpet/linear-cli/issues)。

## 许可证

本项目依据 ISC License 分发。

版权所有 (c) Peter Schilling 及贡献者。

完整许可证文本请参阅 [LICENSE](LICENSE)。
