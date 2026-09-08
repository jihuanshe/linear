---
name: issue-authoring
description: Issue 的责任归属、持久证据、验收依据与后续交接
commands:
  - project teams
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
  - download
---

# 编写可独立交接的 Issue

让没有本对话上下文的接手者知道当前行为、期望结果、责任归属和验收依据。语言、标题和模板沿用目标 workspace 的约定；区分事实、假设和缺失信息。

## 责任归属

发现问题的系统不自动承担修复。日志或分析证明现象，修复与验收落在拥有权威事实的系统。团队和标签依据已有归属、用户规则或 workspace 约定；未确定的归属保留待查，不靠猜测填满字段。需要确认的边界见 [core](core.md)。

接手已有 Issue 前，读取当前负责人、Project、状态以及最近的评论与历史。沿用最新明确决定；改派须有新证据或明确要求，写清转交原因、未完成范围与接手人。转交落实前，当前负责人继续推进，不能用「请别人处理」代替交接。

指定 Project 前，可用 `linear project teams <项目 UUID、slug 或完整名称> --json` 查看完整团队范围。create、update 及 manifest 的 plan/apply 都会检查团队兼容性；移动 Issue 时也检查保留的 Project。使用历史编号改项目时，以远端工单的当前团队校验，不以旧编号前缀推断。读取失败或不兼容会在写入前停止，不自动修改 Project 的团队。先确认责任归属，再选择兼容的 Project 或明确调整 Issue 团队。

## 持久证据

把重建场景或验收必需的材料放入 Issue，注明来源、用途和证明范围：

- 图片用 `issue comment add <id> --body-file <说明> --attach <图片>` 内联，说明当前态或期望态及关注点。
- 录屏、日志、Replay、样本等用 `issue attach <id> <file> --title <标题>` 放入侧栏，或随评论上传，并写明复查方法。
- 要在正文或表格中指定插入位置，先 `linear upload <file>`，再写入返回的 Markdown 片段。
- 外部材料使用接手者可访问的持久链接；仓库材料注明仓库、commit 或 branch、路径。本机路径、聊天附件、文件名和 hash 不能替代原始材料。

上传前移除凭据和非必要个人数据。默认上传为 workspace 私有；仅在用户要求公开访问时使用 `--public`，它只支持位图，其他类型会失败。附件存在不证明接手者拥有外部系统权限；未验证访问时注明。

缺少不可替代的证据时，可先进入 Triage，列明缺失材料和补充动作，不能称为可开发或可验收。上传失败保留已创建的 Issue 并补充材料，不删除重建。

## 交付与跟进

身份和授权按 [core](core.md) 处理，多个执行项用 [issue-delivery](issue-delivery.md)。写后核对正文、目标字段和关键证据，复用已有读回，见 [automation](automation.md)。

关闭时写明原因；仍有后续工作时给出后续 Issue、PR 或负责人的可点击链接。Duplicate 必须指向保留的 Issue，不能只写「重复」。

代码中的临时处理用绝对 URL 引用 Issue，调查与证据留在 Issue。Done 只触发复查，不能替代删除条件的现场验证。

跟进回复依据最新正文和评论，写清已解决项、未决问题与下一步；只复测未验证或已变化的验收项。

## 下载与字节校验

`issue view --json` 只返回记录和附件元数据，不下载文件。需要验证上传的原始字节时，使用返回的 `uploads.linear.app` URL：

```bash
linear download "$asset_url" --output ./evidence.mp4 --sha256 "$expected_sha256" --json
```

输出包含 `assetUrl`、绝对 `path`、字节数 `size` 与 `sha256`；省略 `--sha256` 时仍计算并返回实际哈希。每次重新下载，沿用 CLI 的 workspace 凭据解析，不需要导出 token。目标父目录必须存在，目标文件必须不存在；校验不符、HTTP 或传输失败均非零退出，且不留下目标文件。重复验证使用新的输出路径，不把已有缓存当作远端校验。只接受 HTTPS `uploads.linear.app` 入口，重定向仅允许 HTTPS，且不转发凭据。
