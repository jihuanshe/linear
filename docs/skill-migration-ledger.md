# Linear Skill family 迁移台账

skills#219 原子替换 `linear-cli`、`linear-access`、`linear-request-intake`、`linear-issue-batch-write` 前，每一段被移除的内容必须有明确去向；「删除」也是去向，必须显式记录。本台账随各 commit 增量维护，是替换 PR 的评审证据。

去向词汇：`CLI 命令/help`（命令描述与帮助）、`CLI 指南 <name>`（内嵌指南）、`宿主引导`（新 `linear` 激活 Skill 保留的二进制缺失路由）、`宿主策略`（授权与跨工具边界，由系统提示与仓库指引承载）、`公司知识候选`（移入 OKF 或公司侧工件，skills#219 落定）、`删除`（不再需要，附原因）。

## linear-access（SKILL.md 158 行 + references/create-integration.md 41 行）

| 内容                                                            | 去向                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 底线：API key 不进聊天、不进 shell 历史、不进进程参数           | CLI 指南 core「认证与访问失败」                                           |
| macOS 认证修复：Security Settings 建最小权限 key + `auth login` | CLI 指南 core「认证与访问失败」                                           |
| `LINEAR_GRAPHQL_ENDPOINT` 代理接入与 `--plaintext` 无 keyring   | CLI 指南 core（generic CLI 能力，非组织策略）                             |
| 环境判定路径（macOS / exe.dev / Linux）                         | 公司知识候选：环境路由不是通用 CLI 语义                                   |
| CLI 来源取证（Rotom / mise / shadowed / external 状态机）       | 宿主引导 + 组织安装策略；新 Skill 只保留「二进制缺失 → 组织引导路由」一句 |
| Rotom 收敛、mise 全局安装、shell activation 修复                | 宿主引导 + 组织安装策略（`$mise` / Rotom 文档拥有细节）                   |
| exe.dev HTTP Proxy / Reflection 集成发现、owner 身份核对        | 公司知识候选（exe.dev 环境专属）                                          |
| references/create-integration.md                                | 公司知识候选                                                              |
| 「认证失败不能反推二进制来源错误」                              | CLI 指南 core「认证与访问失败」                                           |

## linear-request-intake（SKILL.md 138 行 + 4 references）

| 内容                                                             | 去向                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 澄清方法：先提取已给信息；便宜的直接假定、贵的问用户；冲突选结果 | CLI 指南 issue-authoring「只保留事实，标注推测」                                            |
| 证据规则：关键 vs 补充、持久化方式、脱敏、缺失显式列出           | CLI 指南 issue-authoring「证据持久化」                                                      |
| 事实源与归属判断（一般化形态）                                   | CLI 指南 issue-authoring「事实源与发现渠道」                                                |
| Issue 模板与标题形态                                             | CLI 指南 issue-authoring「正文形态」                                                        |
| references/linear-workflow.md：写前确认、写后读回、访问检查      | CLI 指南 issue-authoring「写前确认，写后读回」；批量与多对象交付归 delivery（commit 11–12） |
| 开发回复后的跟进清单                                             | CLI 指南 issue-authoring「回复跟进」                                                        |
| mock-to-backend-requirement 产品文档流程与固定文档结构           | 公司知识候选：产品需求整理不是 Linear CLI 语义；skills#219 落定归宿                         |
| references/frontend-backend-diagnosis.md（RN/客户端归属细节）    | 公司知识候选                                                                                |
| references/mock-to-backend-requirement.md                        | 公司知识候选                                                                                |
| references/network-evidence.md（跨工具取证与脱敏）               | 公司知识候选                                                                                |
| 「写入后的固定提醒」话术（飞书转发等）                           | 删除：属对话话术，不是可复用契约；跟进能力已由 issue-authoring「回复跟进」承载              |

## linear-cli（SKILL.md 246 行 + 20 个生成 references + 2 个手工 references）

commit 7b 移除本地生成手册时逐节补记。已迁移部分：

| 内容                                                       | 去向                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| Reliable Automation（NO_COLOR、流分离、jq、写后读回）      | CLI 指南 automation                                    |
| 标签整组替换、内联图片 vs 侧栏 Attachment、`--public` 限制 | CLI 指南 core「影响命令选择的语义陷阱」                |
| document 锚点保护、project description 255 限制            | CLI 指南 core「影响命令选择的语义陷阱」                |
| 从项目 URL 读取、team scope、分页形状、批量前后快照        | CLI 指南 core / automation                             |
| Markdown 文件 flag                                         | CLI 指南 automation                                    |
| GraphQL fallback、schema 发现、heredoc、变量、查询拆分     | CLI 指南 graphql                                       |
| exe.dev HTTP Proxy 一节                                    | 公司知识候选（与 linear-access 同一去向）              |
| 版本前提（2.3.0 references 声明）                          | 删除：版本匹配由内嵌指南与 `version --json` 机制性解决 |

## linear-issue-batch-write（SKILL.md 104 行 + script 620 行 + tests 402 行）

commit 12 迁移受保护批量行为与 fixture 时逐节补记。
