---
name: issue-authoring
description: 事实源判断、证据持久化、写前确认与写后读回、关闭原因与下一跳，让无上下文的接手者能独立继续
commands:
  - issue create
  - issue update
  - issue view
  - issue history
  - issue comment add
  - issue attach
  - issue link
  - issue url
  - issue plan
  - issue apply
  - upload
---

# 编写能在交接中存活的 Issue

Issue 应让没有本对话上下文的接手者理解当前行为、期望结果、责任归属和验收依据。语言、标题和模板遵循目标 workspace 的约定；事实与假设分开，缺失信息明确标注。

## 事实源与发现渠道

发现问题的系统不自动拥有修复。下游日志或分析只能证明现象；修复责任和验收应落在拥有权威事实的系统。不要要求主数据补建未经证实的实体来迁就下游解析，也不要把「重跑下游」当作主数据修复的验收。

team 和标签沿用已有归属、用户规则或 workspace 的明确约定。事实源或责任未明时保留待查项；只有未决信息会改变本次目标、责任、访问范围或业务结果时才问用户。标题措辞等不改变这些决定的细节直接处理。

## 证据持久化

重建场景或验收所需的材料必须进入 Issue，并说明来源、用途和证明范围：

- 图片作为带说明的内联评论：`issue comment add <id> --body-file <说明> --attach <图片>`；说明写清场景、表达的是当前态还是期望态、接手者应关注什么。
- 录屏、日志、Replay、数据样本这类其他文件，用 `issue attach <id> <file> --title <标题>` 建侧栏 Attachment，或作为评论的上传文件；说明来源、用途、复查方法，以及它证明什么、不证明什么。
- 正文或评论的任意 Markdown 位置（包括表格单元格）需要嵌入图片或文件时，先 `linear upload <file>` 取得 asset URL，再把返回的 Markdown 片段写进正文。
- 外部材料写完整、持久、接手者可访问的链接；仓库材料至少写明仓库、revision 或 branch 及路径。
- 本机路径、聊天附件、文件名或 hash 不能替代可访问的原始材料。
- 先脱敏账号、凭据和非必要用户数据。
- 关键证据拿不到且正文无法替代时，可以先创建 Issue 置于 Triage，但必须显式列出缺失证据和补充动作，不得称为可开发或可验收。

## 写入与核验

写入须确认认证和目标 workspace，可用 `auth whoami`；apply 自带身份核对。用户明确要求按给定内容创建或修改已构成授权，无需重复确认。尚未审核的重要结论，以及未授权的批量覆盖、公开上传或敏感材料处理，须展示草稿或变更摘要并取得确认。调查、查看和起草请求不授权写入。

多行 Markdown 使用文件 flag。写后复用 apply 的 `readBack`，或用 `issue view <id> --json` 核对内容和关键证据；读回规则见 [automation](automation.md)。附件存在不证明他人有外部系统权限，无法验证访问时注明。

创建失败保留已确认的草稿；上传失败保留已创建的 Issue，报告缺失材料及补充动作，不删除重建。

## 多对象交付用 manifest

多个执行项用 [delivery manifest](issue-delivery.md)，单项用专用命令。已有授权且内容明确时直接 apply；plan 仅用于可选预览，不增加审批步骤。

## 有始有终

- 关闭 Issue 时写明关闭原因。工作尚未终结时给出明确、可点击的下一跳（后续 Issue、PR 或负责人）。
- 标记 Duplicate 时指向 canonical Issue 的 URL，不能只写「重复」截断信息流。
- Issue 状态只触发复查：Done 不单独证明关联代码可以删除，清理依据是删除条件的现场证据。
- 代码中的临时兜底引用 Issue 时使用可点击的绝对 URL；完整调查、讨论和证据留在 Issue，不复制进代码注释。

## 回复跟进

依据正文和评论中的最新事实，报告已解决项、未决问题及下一步；只复测尚未验证或发生变化的验收项。
