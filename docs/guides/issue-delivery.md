---
name: issue-delivery
description: 用交付清单组合共享操作，按回执续跑并对账未知结果
commands:
  - issue plan
  - issue apply
  - upload
---

# 用交付清单交付 Issue

需要保存多项写入的范围与执行进度时使用交付清单；`issues[]` 可以只有一项。普通字段更新直接调用 `issue update --base-file`，不强制建立执行账本。原始依据、比较规则和直接调用见 `linear guide automation`，正文语法见 `linear guide markdown`。

## 保存清单

先读取要修改的对象，再编写草稿和交付清单。文件路径相对交付清单所在目录：

```bash
linear issue view ENG-123 --json >original.json
```

```json
{
  "schemaVersion": 2,
  "workspace": "acme",
  "issues": [
    {
      "operation": "update",
      "identifier": "ENG-123",
      "baseFile": "original.json",
      "expectFields": ["state"],
      "set": { "title": "新标题", "descriptionFile": "desired.md" },
      "comments": [
        { "bodyFile": "evidence.md", "files": [{ "path": "screenshot.png" }] }
      ],
      "attachments": [
        { "kind": "url", "url": "https://example.com/source", "title": "来源" },
        { "kind": "file", "path": "replay.yrp", "title": "原始 Replay" }
      ],
      "relations": [{ "type": "related", "issue": "ENG-100" }]
    },
    {
      "operation": "create",
      "set": { "team": "ENG", "title": "新建 Issue", "priority": 3 }
    }
  ]
}
```

`original.json` 必须是原始读取产生、符合 `{organization,issue}` 结构的 JSON；其工作区、对象和所需字段必须匹配。可以用 `base` 内嵌同一结构，不能与 `baseFile` 同时使用。明确无保护替换使用 `unprotected: true`，不能附 `base`／`baseFile`；`expectFields` 必须有原始依据，且只接受该对象支持的 API 字段。

`set` 与共享 Issue 操作的选项对应，使用 camelCase：例如 `descriptionFile`、`dueDate`、`addLabel`、`removeLabel`、`unassign` 和 `clearCycle`。团队位于 `set.team`，完整标签替换是 `set.label`。完整字段和有效值以 `issue create --help`、`issue update --help` 及清单校验为准，不另定义一套名称解析规则。

`create` 要求 `set.title` 和 `set.team`，不接受已有 `identifier`、原始依据或期望字段。`update` 要求 `identifier`，可用 UUID 或完整编号。`unassign: true` 清除负责人，`clearCycle: true` 清除周期；不能分别与 `assignee`、`cycle` 同用。标签增删与完整 `label` 替换互斥；空 `label` 替换不受支持，须逐项 `removeLabel`。只追加评论、附件或关系时省略 `set` 和原始依据。

`comments` 中的 `body`／`bodyFile` 互斥，`files` 嵌入评论；`public` 仅适用于该评论的上传图片。`attachments` 创建侧栏附件（Attachment）：`url` 项关联链接，`file` 项先上传再关联。关系使用完整编号或 UUID，支持 `related`、`blocks`、`blocked-by`、`duplicate`；`blocked-by` 反转 `blocks` 方向，同一边已存在时不重复写，不同类型或方向会拒绝。

现有评论的修改／删除、附件删除和关系删除使用专用命令。清单不包含任意脚本、循环或条件语言。

## 预览和提交

```bash
linear issue plan --file delivery.json --json >plan.json
linear issue apply --file delivery.json --confirm-workspace acme --json \
  >apply.json 2>apply.log
```

`plan` 对远端和执行账本都零写入；计划 JSON 包含 `workspace`、`status`、`issues`、`files`。字段判定中，`desired` 是目标值，`remote` 是当前值，`base` 是原始值，人类输出使用同一套字段名。`verdict` 为 `write`（可写）、`idempotent`（已是目标值，无需写入）或 `conflict`（冲突）。内容摘要不能替代阅读草稿。`plan` 使用与 `apply` 相同的准备逻辑；`apply` 会在提交前重新读取与比较，不把计划阶段读到的值当成新的原始依据。

所有本地文件先读取、校验并记录指纹，正文使用同一份已检查字节；上传前还会核对文件是否改变。实际名称解析、项目团队校验、父 Issue 读取、上传和 mutation 由单命令共用的操作负责。`apply` 直接调用这些函数，不转换成 argv 或启动另一份 CLI。

`--confirm-workspace` 必须等于清单 `workspace` 中的工作区短名；执行时还用同一凭据核对远端 `organization.id`，已有执行账本必须属于同一工作区。这个参数不构成写入授权。

`apply` 顺序执行，进度在 stderr，stdout 为一份 `{ok,effect,data}` 写入结果：

```bash
jq '{ok, effect, status: .data.status, summary: .data.summary, verification: .data.verification}' apply.json
jq -e '.ok == true and .data.status == "completed"' apply.json >/dev/null
```

`.data.items[]` 分别记录 `applied`、`failed`、`unknown`、`unattempted`、`skipped` 执行状态，并单列写入效果 `effect`。`skipped` 可以是无需修改，也可以是续跑时跳过已完成项；本次 `effect` 为 `none`。失败默认停止；`--continue-on-failure` 只越过已知无效果的写前失败，不能越过 `unknown`。部分成功不回滚。

## 写入确认与读回核验

整体状态只有在本次执行与规定范围的读回核验都成功时才是 `completed`，并返回零退出码。写入已确认但读回不匹配或不可用时，整体为 `applied-unverified`；保留写入回执，重跑只补需要的读取，不再次发送已完成写入。`effect: applied` 不因读回失败变成可重试。

`.data.verification[].status` 是 `verified`、`different` 或 `unavailable`，`scope` 固定为 `issue-fields-and-object-identities`。核验包括目标 Issue 身份、执行账本中的预期字段，以及本次 Comment／Attachment／Relation 回执对象是否仍关联目标 Issue；不证明评论正文、关系对端与类型、上传字节、页面渲染或通知送达。Markdown 按精确 API 字符串核对；字符串一致也不证明富文本节点等价。

读回最多尝试 3 次，默认每个 Issue 的总时限为 10 秒。仅取消读回，不能据此推断此前 mutation 被取消。`.data.readBack` 按 `issues` 的零起始下标保存 `{organization,issue,receipts}`，不是完整 `issue view`；`createdIdentifiers` 同样按下标记录新建 Issue 的编号。

## 执行账本与恢复

`<manifest>.checkpoint.json` 使用 `schemaVersion: 2`，包含工作区身份和 `items`。执行项 key 绑定清单位置、目标、内容及文件指纹。每次真实派发写入前先保存 `unknown`，收到有效回执后保存 `completed`；上传有独立回执，后续关联失败不会重复上传已完成资产。

执行账本中的状态与本次输出不同：

| 执行账本状态 | 写入效果与恢复边界                                                             |
| ------------ | ------------------------------------------------------------------------------ |
| `completed`  | 必须有 `receipt`，`effect` 为 `none` 或 `applied`；续跑跳过此项                |
| `failed`     | `effect` 为 `none` 且没有 `receipt`；修正失败原因后可以重跑                    |
| `unknown`    | `effect` 为 `unknown`，或已确认 `applied` 但缺少可用回执；所有自动续跑都被阻止 |

遇到 `unknown` 时保留交付清单、引用文件、执行账本和原始结果。按稳定 ID、上传 URL、回执及实际远端对象对账，确认效果后再修订执行账本：已完成项补正确类型的 `receipt` 并置 `completed`，已确认未执行的项才置 `failed` 且 `effect` 为 `none`。无法确定的项继续保留 `unknown`，不用正文相似、标题或 URL 猜测对象。需要人工修改执行账本时，保留修改前副本和对账证据。

`completed` 的 Issue 回执包含 `id` 与 `identifier`，Comment／Attachment／Relation 回执包含对象 `id`，上传回执包含 `assetUrl`、`filename`、`size`、`contentType`、`public`。字段预期仅属于 Issue 回执。回执不匹配、工作区改变或已有执行项 key 从计划中消失时，拒绝续跑；不要删除执行账本来重放原意图。

恢复已完成项不重新执行原始比较，但继续做读回核验。未完成项仍使用原始依据；修改目标值或重新排序可能改变执行项 key。需要新意图时先对账旧效果，再建立只含明确剩余工作的独立交付清单。同一交付清单只能有一个执行者；执行账本不提供并发锁、事务或 exactly-once。

## 从旧协议迁移

`schemaVersion: 1` 的交付清单和执行账本会在执行前明确拒绝。保留原文件及匹配的旧版本二进制，对账或完成旧执行后，再为明确剩余的工作读取新依据、建立 `schemaVersion: 2` 的独立清单。不自动迁移旧执行账本，不删除或覆盖它来重放。

迁移时同时调整顶层 `team` → `set.team`、`labels` → `label`、旧的手抄 `base` → 原始读取 `base`／`baseFile`，以及 `apply` 结果路径 → `.data`。其他命令的当前参数以 `linear <command> --help` 为准，写入结果与读取格式见 `linear guide automation`。
