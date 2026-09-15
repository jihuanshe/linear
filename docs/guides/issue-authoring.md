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

正文说明具体情景、问题、当前结论和要解决的工作，让没有前情的同事也能接手。只保留会改变问题理解、处理范围或后续决定的信息；证据和验证细节放评论或附件。信息不足时指出影响当前判断的具体缺口，区分事实和推测。按内容需要使用自然段、列表或图；预期行为写到可以核验的程度，例如“横屏后按钮应保持可点击”。

## 责任与范围

负责人、状态、优先级和项目归属使用原生属性，正文解释问题和范围。团队、项目和标签依据已有归属、用户决定或工作区约定；归属不明时保留具体疑问，不猜测负责人。

接手已有 Issue 时结合当前正文、属性和未解决讨论判断剩余工作。需要独立执行和跟踪的部分使用 Issue／Sub-issue，零散问题可以留在评论。转交或拆分时说明原因与未完成范围，并链接承接的工作；人员分配按目标工作区的约定处理。

CLI 会检查 Issue 团队与项目是否兼容，需要先查看范围时使用 `linear project teams <项目> --json`。

## 证据放置

把重建场景或验收必需的材料放在接手者可以访问的位置，注明用途和证明范围：

- 图片用 `issue comment add <id> --body-file <说明> --attach <图片>` 内联，说明当前态或期望态及关注点。
- 录屏、日志、Replay、样本等用 `issue attach <id> <file> --title <标题>` 放入侧栏，或随评论上传，并写明复查方法。
- 要在正文或表格中指定插入位置，先 `linear upload <file>`，再写入返回的 Markdown 片段。
- 外部材料使用持久链接；仓库材料注明仓库、提交或分支、路径。本机路径、聊天附件和文件名不能替代接手者可访问的材料。

上传前移除凭据和非必要个人数据。上传默认工作区私有；用户要求公开访问时可用 `--public`，它只支持位图。附件存在不证明外部链接可以访问，未验证时注明。

缺少关键材料时，在正文中说明缺口及其对当前判断的影响。上传失败后保留已创建的 Issue，继续补充材料，避免删除重建产生重复记录。需要核验上传字节时使用 `linear download --help`；`issue view --json` 只返回附件元数据。

## 维护正文与讨论

`issue view <ID>` 默认显示未解决根线程及数量；已解决历史用 `--show-resolved-threads` 读取。未解决线程不天然等于待办，也不要求关闭 Issue 前将评论清零。

讨论形成结论后，更新正文中的问题理解、处理结果与剩余工作；论据、核验过程和记录维护理由保留在评论。需要后续处理的工作有明确去向后，或问题已得到回答时，用 `issue comment resolve <评论 ID>` 收束，可用 `--resolving-comment <回复 ID>` 关联结论。仍缺证据或决定时保持开放，判断改变后可以 `unresolve`。

正文编辑从 `issue export <ID> --output <新目录>` 开始，在导出的 `desired.md` 中保留有效内容并修改。提交使用同目录的原始依据，完整例子与冲突处理见 `linear guide automation`。成员提及和内联锚点的往返限制见 `linear guide markdown`。

关闭时说明原因，未完成的工作链接到后续 Issue 或 PR。判重必须指向保留的 Issue，让读者知道结果和后续讨论在哪里。需要组合多项写入并记录执行进度时使用 `linear guide issue-delivery`。
