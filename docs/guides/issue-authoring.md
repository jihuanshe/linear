---
name: issue-authoring
description: Issue 的责任归属、持久证据、验收依据与后续交接
commands:
  - project teams
  - issue create
  - issue update
  - issue view
  - issue export
  - issue history
  - issue comment add
  - issue comment resolve
  - issue comment unresolve
  - issue attach
  - issue link
  - issue url
  - issue plan
  - issue apply
  - upload
  - download
---

# 编写可独立交接的 Issue

正文让没有前情的同事理解具体情景、遇到的问题、已确认事实和当前要解决的工作。信息不足时说明具体缺口，区分事实和推测。简单问题用几个自然段即可，复杂工作再用必要的列表或图；不为每张 Issue 强制相同章节，也不填写没有增加事实的“验收方向：问题得到解决”。具体的预期行为仍应保留，例如“横屏后按钮应保持可点击”。

负责人、状态、优先级和项目归属使用原生属性，正文不再维护第二份 owner 或状态。独立执行和跟踪的工作用 Issue／Sub-issue，零散问题可以留在评论，不把每条评论机械地变成任务。

## 责任归属

发现问题的系统不自动承担修复。日志或分析证明现象，修复与验收落在拥有权威事实的系统。团队和标签依据已有归属、用户规则或工作区约定；未确定的归属保留待查，不靠猜测填满字段。需要确认的边界见 `linear guide core`。

接手已有 Issue 前，读取当前负责人、所属项目、状态以及最近的评论与历史。沿用最新明确决定；改派须有新证据或明确要求，写清转交原因、未完成范围与接手人。转交落实前，当前负责人继续推进，不能用「请别人处理」代替交接。

按责任归属选项目；`issue create`、`issue update` 和交付清单会检查团队兼容性，报错时按提示处理。需要先查看范围，用 `linear project teams <项目> --json`。

## 持久证据

把重建场景或验收必需的材料放入 Issue，注明来源、用途和证明范围：

- 图片用 `issue comment add <id> --body-file <说明> --attach <图片>` 内联，说明当前态或期望态及关注点。
- 录屏、日志、Replay、样本等用 `issue attach <id> <file> --title <标题>` 放入侧栏，或随评论上传，并写明复查方法。
- 要在正文或表格中指定插入位置，先 `linear upload <file>`，再写入返回的 Markdown 片段。
- 外部材料使用接手者可访问的持久链接；仓库材料注明仓库、提交或分支、路径。本机路径、聊天附件、文件名和哈希不能替代原始材料。

上传前移除凭据和非必要个人数据。默认上传为工作区私有；仅在用户要求公开访问时使用 `--public`，它只支持位图，其他类型会失败。附件存在不证明接手者拥有外部系统权限；未验证访问时注明。

缺少不可替代的证据时，可先进入 Triage，列明缺失材料和补充动作，不能称为可开发或可验收。上传失败保留已创建的 Issue 并补充材料，不删除重建。

## 交付与跟进

身份和授权按 `linear guide core` 处理，多个执行项用 `linear guide issue-delivery`。写后核对正文、目标字段和关键证据，复用已有读回，见 `linear guide automation`。

关闭时写明原因；仍有后续工作时给出后续 Issue、PR 或负责人的可点击链接。Duplicate 必须指向保留的 Issue，不能只写「重复」。

代码中的临时处理用绝对 URL 引用 Issue，调查与证据留在 Issue。Done 只触发复查，不能替代删除条件的现场验证。

跟进回复依据最新正文和评论，写清已解决项、未决问题与下一步；只复测未验证或已变化的验收项。

## 正文与讨论收束

`issue view <ID>` 完整读取评论，默认显示未解决根线程及数量；需要历史时加 `--show-resolved-threads`。未解决线程不天然等于待办，也不构成 Issue 关闭前必须清零的门禁。

讨论形成结论后，把仍适用的事实和决定纳入正文；独立工作有明确的 Issue／Sub-issue 承接。原评论保留历史，问题得到回答或有清楚去向后，用 `issue comment resolve <评论 ID>` 收束，可用 `--resolving-comment <回复 ID>` 关联结论。仍缺证据或决定的线程保持开放；判断被推翻时可以 `unresolve`。

维护正文用 `issue export <ID> --output <新目录>`，阅读原始依据后编辑导出的 `desired.md`，再通过 `issue update --base-file ... --description-file ...` 提交。完整用法和冲突处理见 `linear guide automation`，提及和富文本往返限制见 `linear guide markdown`。这不授权批量清理历史 Issue 或删除评论。

需要核验附件原始字节时使用 `linear download --help`；`issue view --json` 只返回附件元数据，不下载文件。
