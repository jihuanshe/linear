---
name: issue-delivery
description: delivery manifest 的字段保护、checkpoint 续跑、unknown 对账与批量语义，单次和批量共用同一协议
commands:
  - issue plan
  - issue apply
  - upload
---

# 用 manifest 交付完整 Issue

一次交付需要组合正文、评论、文件、Attachment 或关系等多个执行项时，用 delivery manifest 保存完整清单和执行进度，避免遗漏或重复写入。单个执行项直接使用对应专用命令。`issues[]` 放一条是单次，放多条就是批量，协议完全相同。

## Manifest 形态

```json
{
  "schemaVersion": 1,
  "workspace": "jihuanshe",
  "issues": [
    {
      "operation": "update",
      "identifier": "DATA-606",
      "set": { "title": "新标题", "descriptionFile": "description.md" },
      "base": { "title": "旧标题", "description": "旧正文" },
      "comments": [
        { "bodyFile": "evidence.md", "files": [{ "path": "replay-a.yrp" }] }
      ],
      "attachments": [
        {
          "kind": "url",
          "url": "https://example.com/source",
          "title": "Source"
        },
        {
          "kind": "file",
          "path": "replay-a.yrp",
          "title": "Raw replay"
        }
      ],
      "relations": [{ "type": "related", "issue": "DATA-580" }]
    },
    {
      "operation": "create",
      "team": "DATA",
      "set": { "title": "新建 Issue", "priority": 3 }
    }
  ]
}
```

- 文件路径相对 manifest 所在目录解析；plan 和 apply 都会在第一笔写入前校验整批文件的存在、大小和 MIME。
- `set` 的字段词表与 `issue create/update` 一致：title、description/descriptionFile、priority、state、assignee（null 表示清除）、labels（完整集合）、project、parent。update 的每个 `set` 字段必须在 `base` 中记录上次从 Linear 读到的值；create 不使用 `base`。create 另需把 `team` 放在 Issue 条目顶层，与 `operation` 和 `set` 同级；`team` 不是 `set` 字段。
- 同一现有 Issue 的字段、Comment、Attachment 和 Relation 合并为一个 update 条目。重复 identifier（不区分大小写）在本地校验时被拒绝。
- `comments[].files` 上传文件并内联进评论。`attachments` 的 `url` 与 `file` 两种 kind 都创建侧栏 Attachment：`url` 直接链接外部地址，`file` 通过 `path` 指定要先上传的本地文件。
- `relations` 的 `issue` 必须使用 `DATA-580` 形态的完整 identifier，类型词表与 `issue relation add` 一致：related、blocks、blocked-by（由 CLI 反转为上游的 blocks）、duplicate。duplicate 的方向：本条目所在 Issue 成为 `issue` 字段所指 Issue 的 duplicate。Linear 的同一对 Issue 只能保留一种关系：同类型和方向按幂等处理，不同类型或方向在 plan/apply 中报告 conflict；需要替换时先用 `issue relation delete` 显式删除旧关系。
- 已有评论、Attachment 和关系不会被本协议隐式修改或删除；单项修改用对应的专用命令。

## base：并发安全

update 的每个替换字段必须提供上次读到的 `base`，缺失则本地校验失败；空值写 `null`，空标签集合写 `[]`。plan 和 apply 比较 base、目标值和远端当前值：

- `write`：远端仍等于 base，写入。
- `idempotent`：远端已等于目标值，跳过。
- `conflict`：两者都不是，同事改过这个字段，拒绝覆盖。

`set.labels` 表示完整集合替换，因此同样必须带完整 `base.labels`。只需增删标签时使用 `issue update --add-label/--remove-label`；它们映射 Linear 的增量标签原语，不需要先读取并替换整个集合。Comment、Attachment 和 Relation 的追加也不需要字段 base；Relation 保留自己的冲突检查。

conflict 可在授权内合并时，将 base 更新为远端新值、set 改为保留同事更新的合并结果后续跑；内容或决定冲突时请用户裁决。

Markdown 正文的比较做等价规范化（换行、行尾空格、列表符号），Linear 的等价改写不会被误判为漂移。

三方比较之外，apply 读取远端时还核对对象本身：identifier 解析到了别的 Issue（重命名或迁移 team）、目标已归档或已进回收站时，直接拒绝写入该条目。base 保护是乐观校验，不是服务端 CAS——Linear 的更新接口没有版本前置条件，读与写之间存在极窄的竞态窗口。

## plan 与 apply

```bash
linear issue plan --file delivery.json            # 零写入预览：字段 verdict、执行项清单、文件清单
linear issue apply --file delivery.json --confirm-workspace jihuanshe
```

plan 可选，提供字段 verdict、执行项和文件摘要，不展示完整长正文。已有授权且内容明确时直接 apply；需要审核新拟的重要结论时，在对话中展示草稿，见 [issue-authoring](issue-authoring.md)。

apply 在第一笔写入前校验整批 manifest 和文件，并核对认证身份；`--confirm-workspace` 必须与 manifest 一致，它不代替用户授权。每个 Issue 在自己的第一笔 mutation 前读取远端并比较，续跑也一样；执行前查看整批远端 verdict 用 plan。读取失败或 conflict 默认停止，`--continue-on-failure` 可跳过失败或冲突条目继续后续干净条目。

执行项状态为 applied / failed / unknown / unattempted / skipped。已应用或从 checkpoint 跳过的目标均会读回；读回失败不改变 applied，整体返回 applied-unverified 并非零退出。修复访问后重跑只补读回，不重复已成功的 mutation。

`issue apply` 同步等待整批执行和读回；进度写 stderr，stdout 最后输出一份完整结果。外层超时不表示进程退出：原进程仍运行时继续等待，状态不明时禁止启动第二个执行者。

机器输出校验：

```bash
set +e
LINEAR_PROMPT_DISABLED=1 linear issue apply \
  --file "$manifest" --confirm-workspace jihuanshe --json \
  >apply.json 2>apply.log
code=$?
set -e
jq -e '.status == "completed" and ([.verification[].status] | all(. == "verified"))' apply.json >/dev/null
test "$code" -eq 0
jq '{status, summary, createdIdentifiers, verification: [.verification[] | {target, status, url}]}' apply.json
```

`verification[].status` 为 `verified` 只证明目标成功读回。`readBack` 按 identifier 保存完整的 `issue view --json` 响应，使用它核对本次内容；补读条件见 [automation](automation.md)。`stopped-on-unknown` 必须先对账，其他失败按对应恢复规则处理，不一律转人工审批。

## checkpoint 与续跑

`<manifest>.checkpoint.json` 随 manifest 一起交接，以执行项位置和内容哈希记录状态。续跑跳过已成功项，原位修复失败项后按新内容执行。

有 checkpoint 时，只能原位修复失败条目或在 `issues[]` 末尾追加。插入、重排、删除或改写已应用条目会被拒绝；确需重组时，先核实远端状态，再重建或删除 checkpoint。

checkpoint 不是锁。同一份 manifest 只能有一个执行者；确认原进程退出后才能续跑。

- `failed`（CLI 明确报错、无远端副作用）：修复后直接重跑，或用 `--continue-on-failure` 让整批先跑完再统一处理。
- `unknown`（进程异常、结果无法判定）：一切续跑被阻塞。先在 Linear 核实该项的远端状态，再编辑或删除 checkpoint 里的对应执行项。不要盲目重试：Linear 的 create 没有幂等键，重试可能造成重复。

批量不是事务：中途停止保留已成功的结果，不回滚、不删除重建。
