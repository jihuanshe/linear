---
name: issue-delivery
description: 用 manifest 交付 Issue，处理字段冲突、checkpoint 续跑与 unknown 对账
commands:
  - issue plan
  - issue apply
  - upload
---

# 用 manifest 交付 Issue

一次交付包含正文、评论、文件、Attachment 或关系等多个执行项时，用 manifest 保存清单和进度。`issues[]` 可放一条或多条；单个执行项直接用专用命令。

描述和评论中的真实提及、成员 URL 查找与折叠语法见 [markdown](markdown.md)。

## Manifest

```json
{
  "schemaVersion": 1,
  "workspace": "acme",
  "issues": [
    {
      "operation": "update",
      "identifier": "ENG-123",
      "set": { "title": "新标题", "descriptionFile": "description.md" },
      "base": { "title": "旧标题", "description": "旧正文" },
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
      "team": "ENG",
      "set": { "title": "新建 Issue", "priority": 3 }
    }
  ]
}
```

文件路径相对 manifest 所在目录。plan 和 apply 在远端操作前检查整批文件存在和大小；MIME 由扩展名推定，公开上传等限制仍由上传命令校验。

`set` 支持 title、description/descriptionFile、priority（1–4）、state、assignee、labels、project、parent。description 与 descriptionFile 互斥；create 要求顶层 `team` 和 `set.title`，不接受 identifier 或 base。estimate、due date、cycle、milestone、清除 project/parent 等未覆盖操作需另选入口，见专用命令的 `--help`。

update 的每个 `set` 字段都要对应 `base`，`descriptionFile` 对应 `base.description`。同一 Issue 的字段、评论、附件和关系合并为一个 update 条目；重复 identifier 不区分大小写，会被拒绝。

- `assignee: null` 只用于 update 清除负责人；create 省略 assignee 仍可能受 `issue_create_assign_self` 配置影响。
- `labels` 替换完整集合，update 不接受空数组。仅增删标签用 `issue update --add-label/--remove-label`，无需整集替换。
- `comments` 接受互斥的 `body/bodyFile` 和可选 `files`；文件嵌入评论。`public: true` 适用于该评论的所有上传图片，公开访问边界见 [issue-authoring](issue-authoring.md)。
- `attachments` 创建侧栏 Attachment；`kind: "url"` 链接外部地址，`kind: "file"` 先上传本地文件，`title` 可省略。
- `relations[].issue` 使用完整 identifier。类型为 related、blocks、blocked-by、duplicate；blocked-by 反转 blocks 方向，duplicate 把当前条目标为所指 Issue 的重复项。同一对 Issue 同类型同方向时跳过，不同类型或方向报 conflict；替换须先用 `issue relation delete` 删除旧关系。

manifest 不修改或删除已有评论、附件和关系，这类操作用专用命令。

## 字段冲突

`base` 记录上次读取的值，只包含本次 `set` 要替换的字段。可空字段的空值写 `null`，空标签集写 `[]`；未设置优先级时，把远端的 `priority: 0` 写为 `base.priority: null`。

plan 和 apply 比较 base、目标值和远端值：

| verdict      | 条件与动作             |
| ------------ | ---------------------- |
| `idempotent` | 远端已等于目标值，跳过 |
| `write`      | 远端仍等于 base，写入  |
| `conflict`   | 两者都不是，拒绝覆盖   |

负责人可在 `base.assignee` 与 `set.assignee` 中使用用户 UUID，按 ID 比较，不受改名影响；当前负责人的 ID 从 `issue view --json` 的 `assignee.id` 读取。标签比较完整集合；Markdown 比较会规范化换行、行尾空格和列表符号。追加评论、附件、关系不需要字段 base，但关系仍检查冲突。

描述的 `idempotent` 只表示规范化后的 API Markdown 相等，不证明富文本节点等价，也不保证原样重新提交能保留提及。服务端将成员 URL 改写为 `@name` 等形式后，同一清单写入成功再 plan 仍可能报冲突；先核对实际目标和正文，不通过强制重提或扩大文本替换来消除差异。导出与重写风险见 [markdown](markdown.md)。

冲突可在授权内合并时，将 base 更新为远端值，set 改为保留同事修改的合并结果；决定冲突时请用户裁决。目标已归档、进回收站，或 identifier 解析到其他 Issue 时拒绝写入。

指定 `set.project`，或 create 通过 `set.parent` 继承项目时，plan 和 apply 在该 Issue 的首笔写入前检查目标团队属于 Project；检查失败只阻止该 Issue，`--continue-on-failure` 可继续其他条目。全部已成功的条目续跑只读回，不重新检查写入条件。兼容检查不会修改 Project 团队，交接规则见 [issue-authoring](issue-authoring.md)。

base 是写前乐观校验，不是服务端锁；读取与写入之间仍有竞态窗口。

## 预览与执行

```bash
linear issue plan --file delivery.json
linear issue apply --file delivery.json --confirm-workspace acme
```

plan 对远端零写入，预览整批字段 verdict、执行项与文件清单。update 的非 idempotent 字段显示完整 desired、remote 和 base；create 正文与评论仅显示大小等摘要，不能代替草稿审核。plan 可选，已有明确授权和内容时直接 apply；授权规则见 [core](core.md)。

apply 的 `--confirm-workspace` 必须匹配 manifest，plan/apply 还用执行时的同一凭据核对实际 workspace。apply 在每个 Issue 的首笔写入前重读目标，续跑也一样。读取失败或 conflict 默认停止；`--continue-on-failure` 可继续后续条目，但不能越过 unknown。

执行项状态为 applied、failed、unknown、unattempted、skipped。applied 项及从 checkpoint 跳过的项都会读回；若只有读回失败，整体为 `applied-unverified` 并非零退出，已成功项仍保留 applied。恢复访问后重跑只补读回。

apply 同步等待执行与读回，进度写 stderr，最后在 stdout 输出一份结果。外层等待超时不等于进程退出；确认原进程退出前不能启动第二个执行者。

```bash
code=0
LINEAR_PROMPT_DISABLED=1 linear issue apply \
  --file delivery.json --confirm-workspace acme --json \
  >apply.json 2>apply.log || code=$?
jq '{status, summary, createdIdentifiers, verification}' apply.json
test "$code" -eq 0 &&
  jq -e '.status == "completed" and ([.verification[].status] | all(. == "verified"))' apply.json >/dev/null
```

`verified` 仅证明目标成功读回，不能证明字段达到期望。`readBack` 按 identifier 保存 `issue view --json` 响应，用它核对实际内容；补读规则见 [automation](automation.md)。

## Checkpoint 与恢复

`<manifest>.checkpoint.json` 与 manifest 及引用文件一起交接。执行项 key 绑定位置、内容哈希、workspace、operation、identifier 和 team；续跑跳过已成功项。

checkpoint 包含 `schemaVersion: 1`、`items` 和 `createdIdentifiers`。`items[key].status` 只能为 applied/failed/unknown，可另附 `note`；unattempted/skipped 只属于单次输出。`createdIdentifiers` 按 `issues[]` 的零起始下标记录新 Issue，如 `{"0":"ENG-700"}`，没有时仍保留 `{}`。

| 结果                             | 恢复动作                                                                   |
| -------------------------------- | -------------------------------------------------------------------------- |
| `failed`                         | 确认失败原因，修复后重跑；可用 `--continue-on-failure` 继续其他条目        |
| `applied-unverified`             | 修复读取问题后重跑，补读回而不重复写入                                     |
| `unknown` / `stopped-on-unknown` | 先核对远端结果及部分副作用；所有续跑均被阻止，包括 `--continue-on-failure` |

写入子命令启动前先记录 unknown；非零退出或异常不能证明未写入。对账后，确认成功的项改为 applied；确认未执行的项才可改为 failed 或移除记录后重试。部分成功时先修订清单，避免重放已发生的副作用。unknown create 若已成功，还须在 `createdIdentifiers` 补上原条目下标与 identifier。

已有 applied key 必须继续匹配计划。保留成功项的内容、位置和目标，只原位修复失败项或末尾追加；旧版本 key 不匹配时也须先对账。确需重组时，核对远端后从新清单排除已完成内容，再重建 checkpoint，不能删除记录后重放原清单。

checkpoint 不提供并发锁，批量也不是事务：同一 manifest 只能有一个执行者；中途停止保留成功结果，不自动回滚。
