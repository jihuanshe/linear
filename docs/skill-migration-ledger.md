# Linear Skill family 迁移台账

skills#219 原子替换 `linear-cli`、`linear-access`、`linear-request-intake`、`linear-issue-batch-write` 前，每一段被移除的内容必须有明确去向；「删除」也是去向，必须显式记录。本台账随各 commit 增量维护，是替换 PR 的评审证据；skills#219 merge 后作为历史证据保留，不再更新。

去向词汇：`CLI 命令/help`（命令描述与帮助）、`CLI 指南 <name>`（内嵌指南）、`宿主引导`（新 `linear` 激活 Skill 保留的二进制缺失路由）、`宿主策略`（授权与跨工具边界，由系统提示与仓库指引承载）、`公司知识`（已移入 OKF 或公司侧工件）、`删除`（不再需要，附原因）。

## linear-access（SKILL.md 158 行 + references/create-integration.md 41 行）

| 内容                                                            | 去向                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 底线：API key 不进聊天、不进 shell 历史、不进进程参数           | CLI 指南 core「认证与访问失败」                                           |
| macOS 认证修复：Security Settings 建最小权限 key + `auth login` | CLI 指南 core「认证与访问失败」                                           |
| `LINEAR_GRAPHQL_ENDPOINT` 代理接入与 `--plaintext` 无 keyring   | CLI 指南 core（generic CLI 能力，非组织策略）                             |
| 环境判定路径（macOS / exe.dev / Linux）                         | 公司知识：`operations/accessing-linear-from-exe-dev`                      |
| CLI 来源取证（Rotom / mise / shadowed / external 状态机）       | 宿主引导 + 组织安装策略；新 Skill 只保留「二进制缺失 → 组织引导路由」一句 |
| Rotom 收敛、mise 全局安装、shell activation 修复                | 宿主引导 + 组织安装策略（`$mise` / Rotom 文档拥有细节）                   |
| exe.dev HTTP Proxy / Reflection 集成发现、owner 身份核对        | 公司知识：`operations/accessing-linear-from-exe-dev`                      |
| references/create-integration.md                                | 公司知识：并入 `operations/accessing-linear-from-exe-dev`                 |
| 「认证失败不能反推二进制来源错误」                              | CLI 指南 core「认证与访问失败」                                           |

## linear-request-intake（SKILL.md 138 行 + 4 references）

| 内容                                                             | 去向                                                                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 澄清方法：先提取已给信息；便宜的直接假定、贵的问用户；冲突选结果 | CLI 指南 issue-authoring「只保留事实，标注推测」                                                                                                                       |
| 证据规则：关键 vs 补充、持久化方式、脱敏、缺失显式列出           | CLI 指南 issue-authoring「证据持久化」                                                                                                                                 |
| 事实源与归属判断（一般化形态）                                   | CLI 指南 issue-authoring「事实源与发现渠道」                                                                                                                           |
| Issue 模板与标题形态                                             | CLI 指南 issue-authoring「正文形态」                                                                                                                                   |
| references/linear-workflow.md：写前确认、写后读回、访问检查      | CLI 指南 issue-authoring「写前确认，写后读回」（含写前 `auth whoami` 预检与失败留草稿）；显式传标识规则归 automation 指南；批量与多对象交付归 delivery（commit 11–12） |
| 开发回复后的跟进清单                                             | CLI 指南 issue-authoring「回复跟进」                                                                                                                                   |
| mock-to-backend-requirement 产品文档流程与固定文档结构           | 公司 Skill `developer-request-intake`（改名保留，经 `$linear` 交付）                                                                                                   |
| references/frontend-backend-diagnosis.md（RN/客户端归属细节）    | 公司 Skill `developer-request-intake`（随迁）                                                                                                                          |
| references/mock-to-backend-requirement.md                        | 公司 Skill `developer-request-intake`（随迁）                                                                                                                          |
| references/network-evidence.md（跨工具取证与脱敏）               | 公司 Skill `developer-request-intake`（随迁）                                                                                                                          |
| 「写入后的固定提醒」话术（飞书转发等）                           | 删除：属对话话术，不是可复用契约；跟进能力已由 issue-authoring「回复跟进」承载                                                                                         |

## linear-cli（SKILL.md 246 行 + 20 个生成 references + 2 个手工 references）

commit 7b 已删除本仓库的生成管线（`SKILL.template.md`、`scripts/generate-docs.ts`、生成的 `SKILL.md` 与全部 references）；`generate-skill-docs` / `verify-skill-docs` 任务移除，`verify-release` 收敛为源码验证（其中的 guides 测试即替代契约：frontmatter 校验、命令树对照、导入清单完整性、快照）。外部 skills-stable 副本随 skills#219 一并删除。

| 内容                                                                    | 去向                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 生成的命令目录与 15 个领域 references（api/auth/…/version，命令树快照） | 实时命令树：`usage`、`<domain> usage`、叶子 `--help`（唯一拥有者，不再有副本）                                                 |
| references/organization-features.md（手工示例目录）                     | 删除：全部命令示例可由叶子 `--help` 派生；其中唯一的工作流事实（`--add-label` 增量 vs `--label` 整组替换）已并入 CLI 指南 core |
| references/schema.md、config.md                                         | 实时命令树（生成快照，无手工内容）                                                                                             |

SKILL.md 手工章节：

| 内容                                                       | 去向                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| Reliable Automation（NO_COLOR、流分离、jq、写后读回）      | CLI 指南 automation                                    |
| 标签整组替换、内联图片 vs 侧栏 Attachment、`--public` 限制 | CLI 指南 core「影响命令选择的语义陷阱」                |
| document 锚点保护、project description 255 限制            | CLI 指南 core「影响命令选择的语义陷阱」                |
| 从项目 URL 读取、team scope、分页形状、批量前后快照        | CLI 指南 core / automation                             |
| Markdown 文件 flag                                         | CLI 指南 automation                                    |
| GraphQL fallback、schema 发现、heredoc、变量、查询拆分     | CLI 指南 graphql                                       |
| exe.dev HTTP Proxy 一节                                    | 公司知识：`operations/accessing-linear-from-exe-dev`   |
| 版本前提（2.3.0 references 声明）                          | 删除：版本匹配由内嵌指南与 `version --json` 机制性解决 |

## linear-issue-batch-write（SKILL.md 104 行 + script 620 行 + tests 402 行）

commits 11–12 已把可执行工作流全部迁入一等 CLI 命令；外部 Skill 与其 Python script 随 skills#219 删除。

| 内容                                                                 | 去向                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| plan → apply 生命周期、`--confirm-workspace` 重复确认                | CLI 命令 `issue plan` / `issue apply`                                                                          |
| 字段级三方比较（base/desired/remote：幂等跳过、可写、conflict 拒绝） | CLI `src/delivery/engine.ts` planFields + 确定性测试；「乐观校验非服务端 CAS」披露随注释与 issue-delivery 指南 |
| 对象级守卫（identity/team 漂移、archived/trashed 拒绝）              | CLI `src/delivery/engine.ts` objectDrift：apply 拒绝、plan 报 conflict + 确定性测试                            |
| create manifest、逐条 result 写回、续跑跳过                          | delivery manifest `issues[]` + `<manifest>.checkpoint.json`（内容哈希跳过，取代 result 字段回写）              |
| `unverified` 状态与对账要求、create 无幂等键警告                     | checkpoint `unknown` 状态：阻塞续跑直至显式对账；警告进入 issue-delivery 指南                                  |
| 评论/附件/链接的 manifest 外后处理清单                               | 删除：manifest 一等支持 comments/files/attachments/relations，后处理清单不再存在                               |
| Markdown 规范化（CRLF、行尾空格、列表符号）                          | CLI `normalizeMarkdown` + 回归测试；无法安全规范化的差异展示给调用者                                           |
| snapshot 子命令（初始化 update manifest 的 base）                    | 删除：base 由调用者从 `issue view --json` 自取；需要时可由信号驱动恢复为专用命令                               |
| 退出码契约 0/2/3/4                                                   | 删除：收敛到 CLI 统一错误约定（非零 + `✗` stderr），plan 的 `status` 字段与 apply 的逐项结果承载语义           |
| nullable 字段显式 null 清空（project/parent 等）                     | 收窄：v1 仅 assignee 支持清除（`--unassign`）；其余等 `issue update` 长出对应 clear flag 后由信号驱动恢复      |
| 批量语义（整批预校验、顺序执行、部分成功保留、不回滚）               | CLI apply + `--continue-on-failure`；测试覆盖 stop/continue 两种策略                                           |
