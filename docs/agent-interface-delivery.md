# Agent 接口交付记录

状态：一次性交付的执行记录与剩余步骤。设计本体见 [agent-interface-architecture.md](agent-interface-architecture.md)；被替换 Skill family 的逐节去向见 [skill-migration-ledger.md](skill-migration-ledger.md)。本次发布范围的全部 CLI 能力已在集成分支（jihuanshe/linear#5）完成，skills#219 携带 family 原子替换；剩余步骤只有发布编排的 merge、fresh-agent 场景与 skillshare sync。

## 实现 TODO

本仓库推送到 `main` 即触发 `Publish Linear CLI rolling release` workflow。按 2026-08-08 的一次性交付决定，`main` 只在集成完成时接受一次合并：剩余能力全部在集成分支（PR #5，`docs/context-continuity`）上以可评审 commit 累积，一次 merge 产出一个携带全部能力的 release。中间状态不单独发布，向后兼容不是约束。

已完成：

- [x] 建立第一阶段基线：渐进式 usage、命令能力元数据、发现字节核算、生成参考对齐，以及本架构文档。
- [x] Commit 1——加固并定稿渐进式 usage 元数据。
- [x] Commit 2——增加稳定的分发/版本/capability 探针。
- [x] Commit 3——改进根与符合条件领域的零参数导航。
- [x] Commit 4——用少量全新 Amp agent 记录单一激活 Skill 的发现路径和上下文缺口。

本次发布范围（集成分支）：

- [x] Commit 5——内嵌最小的证据驱动指南语料，并添加 `guides list/read`。
- [x] Commit 6——为领域 usage、叶子帮助和 usage JSON 派生指南面包屑。
- [x] Commit 7a——把已安装二进制的访问诊断和 Issue authoring 迁入 CLI 拥有的工作流。
- [x] Commit 7b——移除本地生成手册，并把生成流程转为契约验证。
- [x] Commit 11——暴露 `linear upload` 原语，实现 Issue delivery manifest、零写入 `plan` 和顺序 `apply`。
- [x] Commit 12——让 batch 复用同一 manifest，并添加简单 checkpoint。
- [ ] 发布编排——merge 集成分支、发布、验证安装，然后在 `jihuanshe/skills#219` 内完成全新 agent 验证与 family 原子替换并 sync。

发布后、信号驱动：

- [ ] Commit 8——统一的可选机器输出。
- [ ] Commit 9——批量解析非交互 issue 变更输入。
- [ ] Commit 10——保守的超时、限流和查询重试行为。
- [ ] 机器输出字段投影——仅当实测输出成本证明合理。

Commit 8–10 与 Skill 迁移零耦合：delivery 与 batch 使用现有 `--json` 输出和现有非交互路径即可正确工作。把它们塞进发布窗口只放大一次性变更的范围，不换来迁移收益。

## 拟议的 commit 序列

每个 commit 仍是集成分支上单一可评审、可独立验证的行为边界，但不再各自构成发布边界。编号沿用原路线图；被移出发布窗口的 8–10 号在「发布后工作」一节保留完整规格。

集成分支内的依赖顺序：

| 工作流     | Commits              | 依赖                                                                             |
| ---------- | -------------------- | -------------------------------------------------------------------------------- |
| 发现与知识 | 5 → 6 → 7a → 7b      | 指南、面包屑、access/authoring 所有权和生成手册移除按顺序相互构建。              |
| 交付协议   | 11 → 12              | 与发现工作并行；apply 自身保留 mutation 结果未知的语义，不依赖发布后的重试工作。 |
| 替换与发布 | 发布编排、skills#219 | 两条工作流完成后进入；见「发布编排」。                                           |

架构约束随证明它们的 commit 一起进入 `AGENTS.md`；本路线图不得把设想中的命令/解析器/服务分层描述为已强制执行的仓库不变式。

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

- 针对性的 usage 和元数据测试；
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

### Commit 4：用全新 Amp agent 探测单一激活路径

范围：

- 创建一个临时的单一 `linear` 激活 Skill，不含访问、受理或批量兄弟路由；
- 启动少量没有本次对话历史的全新 Amp agent，覆盖已知命令、未知命令、Linear 激活正反例和一个 Issue authoring 场景；
- 记录实际加载的 Skill、发现命令、产物和恢复路径；
- 将每个具名缺口分类为 CLI 命令/help、内嵌指南、二进制缺失引导或宿主策略，并允许结论为「无需新增机制」。

非目标：

- 不与旧 Skill family 做统计 A/B，不计算成功率或显著性；
- 不让旧 Skill eval 的冻结语料决定新架构；
- 不做最终迁移结论；
- 不改动已冻结的实验一或实验二工件；
- 不因单次 agent 偏差添加 alias、模板或额外状态。

门禁：

- 探测记录列出 prompt、agent 是否加载目标 Skill、实际发现路径、结果和判断；
- 下一个 commit 的指南主题可追溯到真实事故中已确立的跨命令契约，或多个场景共同暴露的上下文缺口；
- 单次可恢复的猜测不会自动变成产品需求。

#### 2026-08-08 探测记录

以下场景使用同一份临时 `linear` Skill 和隔离的只读 CLI fixture；每个 Amp agent 都没有本次设计讨论的历史。fixture 不连接真实 Linear，也不允许写入。两个场景的第一次运行因 fixture 的 `PATH` 漏掉 Deno 而停止；修正探针环境后用相同 prompt 重新运行，没有因此修改产品设计。

| 场景             | Prompt 摘要                                                    | 加载 `linear` | 实际路径与结果                                                                                                                          | 判断                                                                                |
| ---------------- | -------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 已知命令         | 取得 `ENG-107` 的 URL                                          | 是            | 直接调用 `linear issue url ENG-107` 并返回 URL                                                                                          | 已知入口无需强制 preflight，也无需新增机制                                          |
| 未知命令         | 读取 `ENG-112` 的标题、状态和负责人                            | 是            | 初始命令猜测失败后，依次通过根 `usage`、Issue `usage` 找到 `issue inspect`（fixture 时代命令，现命令树为 `issue view`），并返回正确字段 | 现有渐进发现足以恢复；一次猜错不构成 alias 需求                                     |
| GraphQL fallback | 读取专用 Issue 命令未覆盖的 subscribers                        | 是            | 先探测 Issue 命令，再通过 Issue `usage` 和 `api --help` 转到 `linear api`，返回正确 subscribers                                         | fallback 边界可理解；无需把 GraphQL 变成默认路径                                    |
| Issue authoring  | 为 Replay 中出现、但未证明是正式卡片 Password 的编号起草 Issue | 是            | 未执行写入；草稿把 Replay 作为下游观察与原始证据，要求附三份 `.yrp`，并明确不得据此污染官方卡片数据                                     | 真实事故已经证明 `issue-authoring` 指南有价值；本次偏长的草稿不得反向固化成强制模板 |
| 非 Linear 对照   | 列出目录中的 Markdown 文件                                     | 否            | 只执行本地文件查询                                                                                                                      | 单一 Skill 的激活描述没有吞掉无关任务                                               |

这组探测只证明当前薄 Skill 可以激活正确工具，agent 能从渐进式导航恢复，并能理解事故中最关键的 Issue 语义边界。它不证明所有任务均已覆盖，也不产生新的兼容命令、搜索系统、模板或状态机需求。Commit 5 的首批指南继续以真实事故和已确认的跨命令契约为依据，而不是以单次模型输出为规范。

### Commit 5：引入内嵌指南基础

范围：

- 添加由 commit 4 证明必要的最小源指南，预计从 `core`、`automation`、`issue-authoring` 和 `graphql` 开始；
- 让 `issue-authoring` 教授请求澄清、事实源与下游症状区分、证据质量、Issue 拆解、持久交接上下文、关闭原因和下一跳，而不强加僵硬的通用模板；
- 定义并验证指南元数据；
- 用静态文本导入和完整的导入清单嵌入 Markdown；
- 添加 `guides list`、`guides list --json` 和 `guides read`；
- 为新的指南命令添加确定性的命令、导入和输出测试；
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
- 在全新 agent 场景发现恢复缺口之前，无上下文错误链接。

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

本 commit 只移除本仓库生成的重复命令手册，不删除 `jihuanshe/skills` 中仍承担未迁移执行能力的外部 Skill。外部 family 的替换属于 skills#219 的原子替换阶段。

门禁：

- 生成参考的移除不使探索性任务用例或指南感知路由回退；
- 发布验证检查替代契约；
- 一份内容迁移台账核算每一个被移除的整理章节。

### Commit 11：Issue delivery manifest、plan 与 apply

范围：

- 把 `src/utils/upload.ts` 的上传管道暴露为独立的 `linear upload` 命令，返回 asset URL、public/private 与 MIME 信息；
- 定义版本化 manifest，直接映射现有 Issue 字段、Comment 正文中的上传文件、Linear Attachment 和 IssueRelation；
- 让文件路径相对于 manifest 解析；
- 实现对远端零写入的 plan，以简洁元数据展示 create 请求范围，以三方 verdict 展示 update，并列出执行顺序；
- 在第一笔 mutation 前验证整个 manifest 的结构与文件；目标和本次要修改的 Issue 字段在各自 Issue 的第一笔 mutation 前验证；
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
- fixture 覆盖图片、二进制证据、URL 与本地文件 Attachment、IssueRelation、本机路径泄漏和机械字段更新；
- apply 完成后返回已应用或从 checkpoint 恢复目标的当前视图；读回失败保留 applied checkpoint，并返回 applied-unverified；
- `unknown` 立即停止整个 apply 或 batch，直到显式对账。

### Commit 12：batch composition 与 checkpoint

范围：

- 让同一个 manifest 的 `issues[]` 支持单次与 batch；
- 在首笔 mutation 前验证整批本地输入；远端引用与字段在各 Issue 首笔 mutation 前验证；
- 顺序执行并原子记录逐 Issue、逐请求项 checkpoint；
- 添加 stop/continue 策略和结构化汇总；
- 迁移当前受保护 batch Skill 的已接受行为和 fixture；
- 添加与版本匹配的 `issue-delivery` 指南，但不复制命令手册。

非目标：

- 不建立第二套 batch schema 或清单外的附件列表；
- 不引入并发执行、通用事务日志或自动对账协议；
- 不因批量便利削弱字段冲突和 workspace 确认。

门禁：

- 单次和 batch 对同一 Issue 产生相同计划和结果语义；
- `applied` 项在续跑时跳过，`unknown` 项立即停止整个 batch 并阻止续跑或重试；
- 部分成功与剩余项可由 checkpoint 准确恢复；
- 现有 batch 安全与恢复用例全部有 CLI owner。

### skills#219：全新 agent 验证与 family 原子替换

本阶段在 `jihuanshe/skills#219` 内完成，与 `preserving-context-continuity` 是同一个原子评审单元；只在已安装二进制的访问诊断、Issue authoring、Issue delivery manifest 和 batch checkpoint 都有 CLI 拥有者、且携带这些能力的 release 已经上线后合并。全新 agent 场景在 merge 前使用分支内的 Skill 工件与已发布的 CLI 运行——merge 即全公司生效，没有事后补测的窗口。

范围：

- 用全新 Amp agent 运行激活正反例、直接 CRUD、访问故障、Issue authoring、交付和 batch 的代表性场景；
- 在 `jihuanshe/skills` 自己的仓库和评审中更新它；
- 添加一个 `linear` Skill，其描述对完整的 Linear 任务空间激活；
- 只保留规范的二进制缺失引导路由和一条使用 CLI 上下文发现的指令；
- 在同一次受评审的迁移中移除 `linear-cli`、`linear-access`、`linear-request-intake` 和 `linear-issue-batch-write`；
- 提交迁移台账：旧 family 的每个 SKILL.md 章节与 reference 文件标注最终去向——CLI 命令或 help、内嵌指南、二进制缺失引导、宿主策略或删除；
- 验证没有其他外部 Skill 仍声称拥有 Linear 专属的正向路由。

门禁：

- 全新 agent 在直接 CRUD、安装/认证故障、Issue authoring 和批量工作中都选中这一个外部 Skill；
- 普通的非 Linear 任务不选中它；
- 确切已知的命令不付出强制的版本、usage 或指南预检；
- 不确定的 agent 通过 CLI 根导航、命令帮助、错误和内嵌指南面包屑恢复；
- 权威事实源、原始证据、技术审计转写、机械更新和部分成功场景均有可复查的正确路径；
- 不通过猜测的包名或直接 `rm` 删除任何未知二进制；
- 受管的 Jihuanshe 主机不绕过 Rotom，除非组织策略被明确改变；
- 每个被移除的外部 Skill 用例都有明确的 CLI 命令、内嵌指南、二进制缺失引导或宿主策略拥有者；
- 专用命令、GraphQL fallback 和授权边界各有正确代表性路径，且不把激活 Skill 养成一本手册；
- 场景失败按本章的拥有者规则裁定，不为了让测试全绿扩张 CLI 协议。

## 发布编排

两个仓库、一个发布窗口、一次完整状态切换：

1. **集成完成**：`jihuanshe/linear` 集成分支完成本次发布范围的全部 commit，`deno task verify-release` 通过。
2. **merge 与发布**：集成分支一次 merge 进 `main`；`Publish Linear CLI rolling release` 构建并发布携带新 capability 的 release。capability 词汇随本次 release 从 `usage-v1` 扩展为 `usage-v1`、`guides-v1`、`delivery-v1`。
3. **安装验证**：通过 mise（非受管机器）或 Rotom（受管机器）收敛到新版本；`linear version --json` 报告新 capability，`linear guides list` 与 delivery `plan` 冒烟通过。
4. **Skill 替换**：merge `jihuanshe/skills#219`——`preserving-context-continuity`、新 `linear` 激活 Skill、四个旧 Skill 的删除与迁移台账是同一个原子评审单元。
5. **Live**：skillshare sync 使替换在全部配置目标生效；按 lifecycle 规则验证投影内容并运行最小冒烟。
6. **信号**：发布后观察真实使用。效果不好的部分就是下一轮优化的输入；恢复旧 Skill 只需要 revert 一个 PR，不需要专门的回滚仪式。

顺序约束只有一条：新 Skill 引用的入口只存在于新 release，因此 CLI 先上线、Skill 替换随后。这不是渐进主义——中间状态不对外发布，两步是同一次切换在两个仓库的落点。

## 发布后工作（信号驱动）

以下工作项与 Skill 迁移零耦合，不进入本次发布窗口；规格保持可实现精度，编号沿用原路线图，由发布后的真实使用信号排期。

### 开放信号清单

验证各轮实测留下的全部待信号事项，收拢于此；单次出现不行动，信号重复才排期。证据在各轮验证记录原文。

- `issue list` 无 `--json`，机器可读列表需绕道 `linear api`（第三轮；与「机器输出字段投影」证据门控同源）。
- `issue(id).history` 查询返回空 nodes，未分诊（第三轮探针旁证）。
- checkpoint 不是锁：同一 manifest 并发双执行者互不可见、逐项双写（第四轮实测）。指南已声明单执行者边界；锁文件只在真实交接事故出现后考虑。
- 宿主 auto-mode 权限门：无 allow 规则的机器上 agent 的 `issue apply` 会被拦（第二、三轮两侧证据）。这是宿主策略层的部署事项——同事机器需要权限规则或用户在场——不是 CLI 缺陷。
- 内部搜索、文件系统投影与 `guides export`，以及受管主机 Rotom 与直接 mise 的归属：见架构文档「待决事项」11–12，后者需与 Rotom 契约共同决定。

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

### 证据门控：机器输出字段投影

只有在机器 payload schema 和实测输出成本稳定之后，才考虑内置投影。其目的是减少 CLI 到 agent 的输出，不是减少 GraphQL 请求或服务器响应大小；`jq` 和精确的 `linear api` 选择仍是有效替代。

如果真实输出成本支持实现：

- 支持嵌套对象、数组和 connection，不扁平化、不重命名字段；
- 保留 `nodes`、`pageInfo` 和任意 `linear api` payload 嵌套；
- 对每一个不存在的请求路径失败，而不是静默接受部分拼写错误；
- 独立测试投影和紧凑格式化；
- 在代表性用例上证明发现或执行输出字节的实质性减少。

### 架构约束随实现落地

在让某个边界成立且可测试的那个 commit 中同步更新仓库指引。Issue 交付与 batch 的约束属于 commits 11–12，全新 agent 验证与 Skill 迁移属于 skills#219；机器输出纯净性、解析器语义和重试规则随各自的发布后工作项落地。命令、解析器和服务的分层规则只适用于代码和测试已经强制执行它的模块，不得提前全局声明。

## 验证记录（2026-08-09，Kadoraba sandbox）

用户提供了允许破坏性实验的 Kadoraba workspace。以下证据构成 skills#219 merge 前门禁的主体；fresh-agent 场景在 CLI release 后可按同一清单用已发布二进制复跑。

### 真实 API 边界矩阵

| 场景                                                            | 结果                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| create 全链路（字段 + 评论两文件 + URL/文件 Attachment + 关系） | ENG-52：5 项全部 applied，读回逐项在位                                                                                                                                                                                                                                   |
| Markdown 往返幂等（含表格与 `*` 列表的 description 重放）       | 第二次 apply 判定 idempotent，零多余写入                                                                                                                                                                                                                                 |
| 并发冲突（base 过期后 apply）                                   | conflict 拒绝覆盖，退出码 1，不触发 mutation                                                                                                                                                                                                                             |
| 部分成功 + 续跑（坏 relation 目标 → 修复重跑）                  | 评论被 checkpoint 跳过（无重复评论），修复项单独补上                                                                                                                                                                                                                     |
| env-key 认证模式（`LINEAR_API_KEY`）                            | 发现并修复：引擎原先传 `--workspace` 与 env key 冲突；改为 `auth whoami` 前置 org 核对（`03539b7`）                                                                                                                                                                      |
| Linear 真实 Markdown 改写                                       | 发现并修复三种形态：尾随空格剥离、表格分隔行压缩（`\| ---- \|` → `\| -- \|`）、链接目标包尖括号（`](url)` → `](<url>)`）；normalizer 全部吸收并带真实样本回归（`03539b7`、`b0005cb`）                                                                                    |
| 内联图（描述正文、表格单元格、评论、文件链接）                  | `upload` 资产 URL 以 `![...]()` 嵌入后经 Linear 编辑器序列化往返原样保留且判定幂等；像素级渲染双路目检——用户核对 ENG-52（表格、附件 chip、Resources、关系、无重复评论），agent-browser 复用 Chrome profile 截图核对 ENG-53（正文与表格单元格内联图按测试图真实尺寸渲染） |
| Linux 写路径（exe.dev 一次性 VM，交叉编译二进制）               | whoami org 核对、standalone `upload`、delivery apply 评论加文件全部通过；VM 与 key 均已销毁                                                                                                                                                                              |

### 第二轮（同日）：酷刑往返、真实批量、守卫与媒体

| 场景                                                               | 结果                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown 酷刑往返（标题/嵌套列表/代码块/任务框/对齐表格/自动链接） | 再挖出四种改写：`_斜体_`→`*斜体*`、`[x]`→`[X]`、表格对齐冒号被丢弃、裸 URL 自动链接化；normalizer 全部吸收（`a380977`），复放判定 idempotent                                                                                       |
| 真实混合批量（1 create + 2 update）                                | ENG-55 创建含 labels（大小写不敏感解析到既有「Bug」）/state/assignee/priority；ENG-52 state 带 base 更新；ENG-54 标签整组替换 + `--unassign`                                                                                       |
| plan 对 update 的真实三方裁决与 `--json` 形态                      | 逐字段 verdict 正确（conflict/write/idempotent 并存），`--json` 可直接 jq 消费                                                                                                                                                     |
| env-key org 错配守卫（拒绝分支）                                   | kadoraba key + jihuanshe manifest → 干净拒绝并写明两侧身份；`--confirm-workspace` 错配同样拒绝                                                                                                                                     |
| public/private 资产语义                                            | `public: true` 图片走 `public.linear.app` 未登录 200；私有文件走 `uploads.linear.app` 未登录 401；中文文件名原样保留                                                                                                               |
| Fresh-agent 冲突处置探针                                           | plan 见 conflict 后正确归因「同事在批准后并发改名」；拒绝删 base 强推、拒绝 `linear api` 绕过、拒绝拆分交付；核验远端零副作用后给出正确的用户裁决建议。apply 本身被宿主权限门拦下且 agent 未绕过——「CLI 能力不是授权」在实践中成立 |

### Fresh-agent 场景（本机，5 个无历史上下文的 sub-agent）

| 场景                                             | 观察到的路径                                                                                                       | 判定 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---- |
| 技能引导只读（查标题/状态/评论数）               | 根导航 → `issue usage` → `view --json`，并自验 `--show-resolved-threads`                                           | 通过 |
| 技能引导多对象交付（建 issue + 日志证据 + 关系） | 经 `guides read issue-delivery/issue-authoring` 自行选择 manifest，plan → apply → 读回；自拟复现步骤诚实标注未实测 | 通过 |
| 无技能纯 CLI 发现                                | `--help` 链两步定位 `issue view`，结果正确                                                                         | 通过 |
| GraphQL 兜底（读 subscribers）                   | 专用命令查无 → 一次错误猜测（`linear graphql`）→ `guides read graphql` → schema 转储 → `linear api` heredoc        | 通过 |
| 阴性对照（非 Linear 任务）                       | 全程未触碰 linear                                                                                                  | 通过 |

信号备注：交付探针当时发现 `issue view --json` 不含 relations，验证关系需绕道 `linear api`；该信号随后在 AI-1102 的真实交付审计中重复，现已补入结构化 view 读回。

发布后复跑清单补一项（原始事故的直接复刻；冻结 eval 语料有意只测命令机械面，语义场景归 fresh-agent 探测）：「依据技术审计结果批量重写多张已有 Issue 的标题或正文」——期望 fresh agent 先经 issue-authoring 在对话中展示用户尚未审核的拟写内容，再走 manifest plan 的三方 verdict 与 apply，而不是把审计结果直接当作已审核正文机械写入。

### 第三轮（次日，换机后）：权限门放行、规模、跨机器交接与裁决闭环

换机本身构成真实交接：新机器上仅有 Kadoraba 凭据（生产 jihuanshe 凭据已登出），分支二进制现场重编译。

| 场景                                         | 结果                                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主权限门的放行侧                           | 项目级 `settings.local.json` 增加 allow 规则后，fresh agent 的 mutation 命令即时放行——与上一轮的拦截构成同一机制（宿主授权，而非 CLI 能力）的两侧证据                                                                        |
| 规模批量（10 create + 2 update 单 manifest） | 12 条目 46 秒全部 applied（ENG-57–66 创建，ENG-54/55 更新），plan 在首笔写入前校验全部文件的存在、大小、MIME 与 sha256                                                                                                       |
| 大文件（6 MB 二进制经 `comments[].files`）   | 上传成功，评论 chip 在位，未登录 401                                                                                                                                                                                         |
| checkpoint 跨机器交接                        | 首跑 stopped-on-failure（坏 relation 目标），整目录迁至不同绝对路径续跑：3 项 skipped 零重复（读回核实每个 create 恰一条、评论恰一条），修复项因内容哈希变化自动重跑，unattempted 项补齐；manifest 修改不整批作废 checkpoint |
| unknown 对账闸门                             | checkpoint 注入 unknown 条目后 apply 拒绝一切续跑、点名条目、给出对账指引，阻塞发生在任何写入之前；对账恢复后复跑全 skipped 零写入                                                                                           |
| Fresh-agent 冲突裁决闭环                     | 持用户裁决的无上下文 agent 正确识别漂移、保留同事改动、追加审计后缀、独立 GraphQL 回读并诚实披露边界；但它用无 base 的专用命令直改收尾并自曝读写竞态窗口——指南此前未写明裁决后的收尾路径，本轮已在 issue-delivery 补明确条款 |
| 快照测试的时区依赖（换机暴露）               | 4 个 view 快照测试在 UTC+8 宿主上因日期渲染跨日失败（`1/15`→`1/16`），快照录制于 UTC 环境；已在 `deno.json` 的 test 与 update-snapshots 任务固定 `TZ=UTC`，人类输出的本地化渲染行为不变                                      |

信号备注（不立即行动）：`issue list` 无 `--json`，agent 需要机器可读列表时绕道 `linear api`（与「机器输出字段投影」证据门控一致，留待信号重复）；`issue(id).history` 查询返回空 nodes（未分诊）。

### 第四轮（同日）：checkpoint 编辑语义与执行者边界

| 场景                          | 结果                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前插/重排已应用条目（修复前） | 前插一条后续跑：位置键全部失配，已应用的两条 create 被静默重建为重复 issue，状态仍报 completed——本轮最严重发现                                                 |
| 结构漂移守卫（修复后）        | apply 在任何写入前拒绝续跑，点名全部漂移键并给出对账指引；末尾追加与原位修复失败条目仍放行。确定性测试与真 API 双路验证                                        |
| 同一 manifest 并发双执行者    | 两个执行者互不可见，每条 create 各写两遍、双双报成功，checkpoint 只剩后写者——checkpoint 不是锁；指南补「移交执行权，非复制执行权」条款，锁文件留作发布后信号项 |
| `--continue-on-failure`       | completed-with-failures 退出码 1，两处失败收集、三条 create 继续；原位修复后续跑恰好补齐，全程零重复                                                           |
| project/parent 字段解析       | create 经 manifest 解析 project 名称与 parent identifier，读回在位                                                                                             |
| 超限文件失败形态              | 60 MB 文件 plan 通过（plan 不设本地体积上限），apply 上 Linear 拒绝时原文透传限额信息（free plan 10 MB），评论零部分写入，状态可续跑——无需修复                 |

### 第五轮（同日）：术语与语言修订

双 fresh-agent 评审（术语一致性对照 Linear 官方文档、语言质量逐句过）后修订五份指南、CLI 文案与快照：

- 上游术语归位：「侧栏链接」并入侧栏 Attachment（`url`/`file` 两种 kind 是同一对象，`file` 通过 `path` 指定本地文件）；blocked-by 标明为 CLI 反转、非上游枚举值；duplicate 方向写明；「Security Settings」改官方路径 Settings > Account > Security & Access；env-key 报错 organization 改 workspace；全 CLI 用户可见文案「issue ID」统一为「issue identifier」（ENG-123 形态）。
- 词表归一：apply 执行项状态五值以 issue-delivery 指南为唯一来源，issue-authoring 降为指针（修复 4 值/5 值漂移，连带 issue-apply.ts 头注释）；plan 的字段 verdict（write/idempotent/conflict）在指南点名；manifest 层「Issue 条目」与 checkpoint 层「执行项」分层命名；三方比较在 issue-delivery 定义一次。
- 与实现对齐：checkpoint 描述改为「记录全部已尝试执行项」；分页拼接补触发条件（`--limit 0` 或超单页）；「当前目录配置」写明 config 与目录名的推断机制。
- 语言：拆花园小径句与双重否定；定义和例子移出括号；「宿主」首次出现处定义；删除对设计的自评句；automation 补「何时读本指南」定位句。

### 第六轮（同日）：迁移覆盖度终审

fresh agent 拿四个被删 Skill 的原文（skills 仓库 main）逐节对照迁移台账与每个声称的去向。用户点名的三块：request-intake 教学近逐字保留于 developer-request-intake；issue 写法主体在 issue-authoring 且有增量；批量安全三大支柱（字段白名单、三方比较、checkpoint）迁移且升级。抓到 6 处静默丢失，全部处置：

- 对象级守卫回归（最重）：旧批量脚本拒绝写 identity/team 漂移与 archived/trashed 目标，新 engine 曾静默写入。已迁入 `objectDrift`：apply 拒绝、plan 报 conflict，view 查询补 `archivedAt`/`trashed`，确定性测试覆盖三种拒绝与 plan 形态。
- 「乐观校验非服务端 CAS」披露进 planFields 注释与 issue-delivery 指南；写前 `auth whoami` 预检与失败留草稿进 issue-authoring；「显式传标识、不靠 branch 推断」进 automation。
- exe.dev 代理 origin 应取自 Reflection（而非拼接主机名）与环境判定探针两处修入公司知识文件（skills#219 分支）。台账两行随实际去向更正。

### 第七轮（同日）：Codex review 分诊

linear#5 上 13 条 Codex 评论（两批，含 2 条 P1）逐条对源码裁决：10 条成立并修复，3 条按设计拒绝。

修复：进程中断窗口关闭——mutation 发射前先落 in-flight unknown checkpoint，硬崩溃后的续跑被 unknown 闸门拦下而不是重复写入，原先文档接受的「极窄窗口」就此消除；workspace 核身改为无条件——项目级 `.linear.toml` 的 `api_key` 在凭据解析中越过 `--workspace`，whoami 预检现以与子命令相同的 flag 解析身份并比对 manifest workspace；plan 对 comment-only update 也读取目标并做对象核对；manifest 校验新增五类显式拒绝（update 空 labels、update 带 team、create 带 assignee null、空评论正文、超限文件）；`issue create` 拒绝 `--json` 与 `--start` 组合以保住 stdout 协议；`upload` 多文件在首个网络请求前整批验大小。

拒绝：createdIdentifiers 复用风险已被结构漂移守卫覆盖；整批预读 update 冲突与 relation 目标与「批量不是事务、失败由 checkpoint 续跑承接」的设计冲突，预读在 TOCTOU 下只制造假信心——指南措辞已同步澄清 apply 的校验边界。

## 完成定义

架构在满足以下条件时完成：

- 全部剩余能力经集成分支的一次 merge 与一个 release 交付，skills#219 在同一发布窗口完成 family 替换与 skillshare sync；
- 调用 `linear` 教授渐进式发现；
- 一个外部 Skill 可靠地对每个 Linear 任务激活，而不把访问、authoring 或批量工作切分进兄弟 Skill；
- 二进制缺失引导仍然可用，而已安装二进制的诊断与修复由 CLI 拥有；
- 命令事实只来自实时命令树；
- 已安装用户可以离线列出并阅读版本匹配的指南；
- 相关指南可以从领域和叶子帮助中发现，且不使输出膨胀；
- 确切已知的命令直接运行，而不确定的 agent 可以只动态加载相关的 CLI 拥有的工作流；
- 组织与跨工具策略留在通用 CLI 行为之外；
- `issue-authoring` 能帮助调用者区分事实所属系统、发现渠道和修复后的第一复查点，并跨交接保留意图；
- `linear upload` 让任何 Markdown 位置——描述、评论、表格单元格——都能嵌入已上传的 artifact；
- 一个文件驱动的 Issue delivery manifest 可以预览并顺序执行 Issue 字段、Comment 及其上传文件、Linear Attachment 和 IssueRelation；
- batch 复用同一个 manifest，并用简单 checkpoint 避免重复已确认成功的步骤；
- create 可以先查看简洁的目标与交付范围摘要；实质性 update 显示字段三方 verdict，需要审核的新拟正文由 Agent 在对话中展示，机械字段更新和普通补充保持轻量；
- apply 完成后返回每个已应用或从 checkpoint 恢复的目标 Issue 当前视图，读回失败不得报告 completed；
- 关键原始证据进入可访问附件，Issue 不依赖创建者机器或原聊天；
- Issue 关闭原因和仍存在工作的可点击下一跳无歧义；
- 生成的静态命令手册和每领域参考被移除；
- 四个旧 Linear Skill 在同一次迁移中被一个激活 Skill 原子替换；
- 全新 agent 场景和确定性测试证明事故导出的语义边界、GraphQL fallback 与授权边界仍有正确拥有者。
