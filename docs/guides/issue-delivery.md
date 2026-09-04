---
name: issue-delivery
description: delivery manifest 的字段保护、checkpoint 续跑、unknown 对账与批量语义，单次和批量共用同一协议
commands:
  - issue plan
  - issue apply
  - upload
---

# 用 manifest 交付完整 Issue

一次交付涉及正文、评论、文件、Attachment 或关系时，手工串联多条命令正是附件被遗漏的方式。delivery manifest 把整个交付写成一个文件；`issues[]` 放一条是单次，放多条就是批量，协议完全相同。

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
- 同一个现有 Issue 在一份 manifest 中只能有一个 update 条目；把它的字段、Comment、Attachment 和 Relation 合并在该条目中。重复 identifier（包括大小写等价形式）会在任何远端读取、checkpoint 或 mutation 前被拒绝，避免后一个条目的 conflict 发生在前一个条目已经写入之后。
- `comments[].files` 上传文件并内联进评论。`attachments` 的 `url` 与 `file` 两种 kind 都创建侧栏 Attachment：`url` 直接链接外部地址，`file` 通过 `path` 指定要先上传的本地文件。
- `relations` 的 `issue` 必须使用 `DATA-580` 形态的完整 identifier，类型词表与 `issue relation add` 一致：related、blocks、blocked-by（由 CLI 反转为上游的 blocks）、duplicate。duplicate 的方向：本条目所在 Issue 成为 `issue` 字段所指 Issue 的 duplicate。Linear 的同一对 Issue 只能保留一种关系：同类型和方向按幂等处理，不同类型或方向在 plan/apply 中报告 conflict；需要替换时先用 `issue relation delete` 显式删除旧关系。
- 已有评论、Attachment 和关系不会被本协议隐式修改或删除；单项修改用对应的专用命令。

Feedback 分诊按「一组一条 Issue」放进同一份 manifest；正文、Case URL 和人话 Comment 的写法见 [issue-authoring](issue-authoring.md)。不要为新增成员复制 Issue，也不要把组内数量写进永久正文。

## base：并发安全

你准备材料需要时间，期间同事可能改了同一个 Issue。update 的每个替换字段都必须写 `base`（你上次读到的值）；缺失会在本地校验阶段失败，不会降级成无条件覆盖。当前值为空时显式写 `null`，空标签集合写 `[]`。apply 对每个字段做三方比较，比较 base、目标值和远端当前值，verdict 用同一词表出现在 plan 输出里：

- `write`：远端仍等于 base，写入。
- `idempotent`：远端已等于目标值，跳过。
- `conflict`：两者都不是，同事改过这个字段，拒绝覆盖。

`set.labels` 表示完整集合替换，因此同样必须带完整 `base.labels`。只需增删标签时使用 `issue update --add-label/--remove-label`；它们映射 Linear 的增量标签原语，不需要先读取并替换整个集合。Comment、Attachment 和 Relation 的追加也不需要字段 base；Relation 保留自己的冲突检查。

报 conflict 后，把远端当前值与你的意图一起交给用户裁决；执行裁决时把 base 刷新为远端当前值、把 set 改成裁决后的目标，重新 plan/apply。这条路保留 base 保护：裁决与执行之间同事再次修改会再次报 conflict，而不是被静默覆盖。不要为绕过 conflict 改用无 base 的直接更新。

Markdown 正文的比较做等价规范化（换行、行尾空格、列表符号），Linear 的等价改写不会被误判为漂移。

三方比较之外，apply 读取远端时还核对对象本身：identifier 解析到了别的 Issue（重命名或迁移 team）、目标已归档或已进回收站时，直接拒绝写入该条目。base 保护是乐观校验，不是服务端 CAS——Linear 的更新接口没有版本前置条件，读与写之间存在极窄的竞态窗口。

## plan 与 apply

```bash
linear issue plan --file delivery.json            # 零写入预览：字段 verdict、执行项清单、文件清单
linear issue apply --file delivery.json --confirm-workspace jihuanshe
```

plan 是可选的安全与执行摘要，不是人类审批界面，也不是每次 create 前的强制仪式。create 展示目标 workspace/team、标题和归属、长正文的来源与大小、Comment 上传公开性、文件、Attachment 和关系，但不把完整长正文复制进终端；需要用户审核 Agent 新拟的正文时，Agent 必须在对话中展示草稿。update 继续展示本次字段的 base/desired/remote verdict；Relation 逐项显示 add/idempotent/conflict。用户已经明确要求按给定内容写入时，不需要为了确认而重复确认。

apply 在第一笔写入前重复整批 manifest 与文件校验，然后按顺序在每个 Issue 自己的第一笔 mutation 前读取远端并比较。默认策略遇到读取失败或 conflict 就停止，保留已经成功的结果；显式 `--continue-on-failure` 跳过失败或冲突条目并继续后续干净条目。需要在执行前查看全部远端 verdict 时显式运行 plan；apply 不重复整批远端预读，也不把客户端检查描述成锁或事务。checkpoint 续跑沿用同一套逐 Issue 检查。`--confirm-workspace` 必须重复 manifest 里的 workspace，防止把准备好的 manifest 打到错误目标——它不是授权，写入授权始终来自宿主和用户。

apply 逐执行项返回 applied / failed / unknown / unattempted / skipped，结束后读回每个本次已应用或从 checkpoint 跳过的目标 Issue。mutation 已成功但当前视图读回失败时，执行项仍保持 applied 以免误重试，整体状态返回 applied-unverified 并以非零退出；修复访问后重跑会跳过 mutation，只重试读回。

## checkpoint 与续跑

checkpoint 写在 manifest 旁边（`<manifest>.checkpoint.json`），随 manifest 一起交接。每个已尝试的执行项以「位置 + 内容哈希」为键记录结果状态。续跑跳过已确认成功的执行项；修复失败处的内容会改变对应执行项的哈希键，按新内容重跑。

续跑期间对 manifest 的安全编辑只有两种：原位修复失败的 Issue 条目，或在 `issues[]` 末尾追加新条目。在已应用条目之前插入、重排，以及删除或改写已应用条目，都会使执行项的位置键失配。这种情况下 apply 拒绝续跑，而不是重复已落地的写入。确实需要重组时，先在 Linear 核实远端状态，再重建或删除 checkpoint。

checkpoint 不是锁：两个执行者同时 apply 同一份 manifest 看不见彼此，每一项都会写两遍。交接是移交执行权，不是复制执行权；同一份 manifest 同一时刻只能有一个执行者。

- `failed`（CLI 明确报错、无远端副作用）：修复后直接重跑，或用 `--continue-on-failure` 让整批先跑完再统一处理。
- `unknown`（进程异常、结果无法判定）：一切续跑被阻塞。先在 Linear 核实该项的远端状态，再编辑或删除 checkpoint 里的对应执行项。不要盲目重试：Linear 的 create 没有幂等键，重试可能造成重复。

批量不是事务：中途停止保留已成功的结果，不回滚、不删除重建。
