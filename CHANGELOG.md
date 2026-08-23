# 变更日志

本变更日志记录 [`jihuanshe/linear`](https://github.com/jihuanshe/linear) 相对于上游基线的下游累计变更。`main` 发布的滚动构建使用由提交派生的版本号，因此每个构建的准确历史记录保留在 [GitHub Releases](https://github.com/jihuanshe/linear/releases) 和 Git 历史中，而不是在这里重复列出编号条目。

## 自上游 2.3.0 以来的下游变更

### Agent 与自动化契约

- 新增 `LINEAR_PROMPT_DISABLED=1`，使交互式提示在读取 stdin 前失败。它不会选择默认值、授予同意，也不会替代显式的 mutation 标志。
- 让非 TTY、`NO_COLOR`、`TERM=dumb` 和 `CLICOLOR=0` 场景下的输出不带颜色，同时将 stdout 数据与 stderr 诊断信息及分页器决策分离。
- 统一将 usage 错误输出到 stderr，并使用退出码 `2`；验证错误和运行时失败继续使用退出码 `1`。
- 新增渐进式 `linear usage` 和 `linear <domain> usage` 发现机制，并支持使用可选的 JSON 描述命令参数、选项、别名、写入和交互能力、确认要求以及输出模式。
- 新增离线 `linear version --json` 探针，提供稳定的发行版身份、发布版本和增量协议能力，同时不将构建身份与安装归属混为一谈。
- 为 `auth whoami`、`team list`、`project list`、`project view` 和 `issue update` 增加机器可读输出；更新响应包含即时验证所需的最终优先级和标签。
- 在 JSON 中保留 GraphQL 字段名称和 connection 结构。分页列表会拼接 `nodes`、保留 `pageInfo`、验证 `--limit`，并在达到请求的上限时停止，同时不丢失后续分页游标。
- 将 JSON、终端样式、分页、提示和 mutation 同意保持为相互独立的契约，而不是引入一个包办一切的 Agent 模式。

### 指南与 Issue 交付

- 将五份版本匹配的中文工作流指南（core、automation、issue-authoring、issue-delivery、graphql）嵌入二进制，并通过 `linear guides list/read` 提供；domain usage、叶子命令帮助和 usage JSON 中都增加了相关指南的导航线索。
- 新增 `linear upload`，使上传的资源可以嵌入 Markdown 的任意位置，包括表格单元格和评论，并支持可选的公开图片 URL。
- 新增声明式 Issue 交付：`linear issue plan` 以零写入方式预览 manifest，提供简洁的创建元数据、逐字段三方更新判定（基于记录的 base 判断 write/idempotent/conflict），以及 add/idempotent/conflict Relation 判定结果，防止用另一条边替换已有关系；`linear issue apply` 按顺序执行 manifest，逐项报告 applied/failed/unknown/unattempted/skipped，并强制进行最终 read-back。mutation 已成功但无法读取 view 时，仍会写入 checkpoint，并返回 `applied-unverified`，而不是错误地报告完成。
- 让包含多个 Issue 的 manifest 成为同一协议的批处理形式：checkpoint 会在启动每个 mutation 前，将其记录为 in flight；恢复时跳过已确认成功的项；遇到结构漂移或未解决的 unknown 结果时拒绝恢复；`--continue-on-failure` 会收集失败项而不中止。重复的更新目标会在远程读取或 checkpoint 操作前被拒绝，因此一个 Issue 不会在后续条目冲突前发生部分 mutation。
- 让更新 manifest 采用 fail-closed 策略：每个替换字段都必须携带上次读取的 `base`，包括显式的 null 和空集合值。Apply 会在写入某个 Issue 前立即重新读取该 Issue，并拒绝自 `base` 以来发生变化的字段；批处理仍按顺序执行，通过 checkpoint 记录部分交付并显式决定停止或继续，而不是声称存在批级锁或事务。
- 规范化 Linear 等价的 Markdown 重写（根据真实样本观察到七种形式并加入回归测试），使往返转换保持幂等，而不是报告虚假的冲突。
- 将 `version --json` 的能力扩展为 `usage-v1`、`guides-v1` 和 `delivery-v1`，并移除生成的 Skill 手册——命令事实现在只存在于实时命令树和版本匹配的指南中。

### Mutation 安全性与正确性

- 在显式替换整个 label 集合之外，新增增量式 `issue update --add-label` 和 `--remove-label` 操作。
- 要求非交互式 `issue update` 调用至少提供一个显式更新选项。
- 为单个和批量 Issue 删除增加 UUID 支持。
- 让 `team delete --dry-run` 变为非交互且零 mutation，并将最终确认移到任何 Issue 迁移开始之前。
- 即使源团队为空，也会验证显式的 Issue 迁移目标；每完成一个标识符映射就立即报告，使部分进度在后续失败后仍然可见。
- 将命令级 workspace label 选择器重命名为 `label list --workspace-labels`，避免再与全局的 `--workspace <slug>` 凭据选择器冲突。
- 在非 Windows 系统上，将明文凭据文件限制为仅文件所有者可读写。

### 开发与分发

- 新增基于 Deno `2.9.4` 的可复现 Amp Orb 设置：在 Orb 稳定命令 PATH 上提供主 checkout 的源码包装器，并缓存依赖。
- 新增本地及 Pull Request 源码门禁（`deno task verify-release`），覆盖 GraphQL 生成、格式化、lint、类型检查和非 Keyring 测试；发布 CI 继续保留隔离的 Linux Keyring 集成测试。
- 对经授权的 `main` 更新，为五个平台发布滚动构建，包括安装归档和独立的自更新二进制；二进制命名为 `0.0.<commit timestamp>-g<short commit>`，并附带校验和及构建溯源信息。
- 将每个成功发布的 GitHub Release 记录为一个已完成的 Linear Release，使用该次推送的准确提交范围、相同的版本号以及指向 GitHub Release 的链接。
- 串行执行滚动发布任务，不取消进行中的任务；最多保留 100 个待处理的 `main` 更新，并为每次成功运行发布独立版本。
- 记录了从 `github:jihuanshe/linear` 使用 mise 安装的方式；源码管理的版本仍为 `0.0.0-dev`。
- 新增 `linear update`：由 mise 接管 mise 管理的安装；对于直接从 GitHub Releases 下载的二进制，则先验证校验和，再以原子方式替换。

### 仓库与文档

- 围绕此 fork 的自动化契约、当前安装路径、上游归属说明和贡献流程，重写 README。
- 将可复用的 Agent Skills 移至标准的 `.agents/skills/` 布局，并移除 Claude 插件打包、Claude 专用设置和 Zed 专用设置。
- 将 Deno manifest 中的许可证元数据修正为 ISC，与仓库继承的许可证保持一致。

## 上游基线与致谢

此 fork 基于 [`schpet/linear-cli` 2.3.0](https://github.com/schpet/linear-cli/releases/tag/v2.3.0)，由 [Peter Schilling](https://github.com/schpet) 创建，并由其[贡献者](https://github.com/schpet/linear-cli/graphs/contributors)共同开发。

截至该基线的完整历史仍可在[上游变更日志](https://github.com/schpet/linear-cli/blob/v2.3.0/CHANGELOG.md)和[上游发布记录](https://github.com/schpet/linear-cli/releases)中查看。本下游变更日志有意不复制或重新标记这些发布记录。
