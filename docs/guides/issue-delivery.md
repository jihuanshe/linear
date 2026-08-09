---
name: issue-delivery
title: Delivering complete issues with plan and apply
description: delivery manifest 的字段保护、checkpoint 续跑、unknown 对账与批量语义——单次和批量共用同一协议
keywords:
  - delivery
  - manifest
  - batch
  - checkpoint
  - conflict
  - resume
  - 批量
  - 交付
  - 续跑
  - 冲突
commands:
  - issue plan
  - issue apply
  - upload
seeAlso:
  - issue-authoring
  - automation
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
      "base": { "title": "旧标题" },
      "comments": [
        { "bodyFile": "evidence.md", "files": [{ "path": "replay-a.yrp" }] }
      ],
      "attachments": [
        {
          "kind": "url",
          "url": "https://example.com/source",
          "title": "Source"
        }
      ],
      "relations": [{ "type": "related", "issue": "DATA-580" }]
    }
  ]
}
```

- 文件路径相对 manifest 所在目录解析；plan 和 apply 都会在第一笔写入前校验整批文件的存在、大小和 MIME。
- `set` 的字段词表与 `issue create/update` 一致：title、description/descriptionFile、priority、state、assignee（null 表示清除）、labels（完整集合）、project、parent；create 另需 `team`。
- `comments[].files` 上传并内联进评论；`attachments` 的 `url` 建侧栏链接、`path` 上传文件为侧栏 Attachment；`relations` 透传 related/blocks/blocked-by/duplicate。
- 已有评论、Attachment 和关系不会被本协议修改或删除；单项修改用对应的专用命令。

## base：并发安全

你准备材料需要时间，期间同事可能改了同一个 Issue。给字段写上 `base`（你上次读到的值）后，apply 只在远端仍等于 base 时才写入；远端已等于目标值则幂等跳过；两者都不是就报 conflict 并拒绝覆盖。只改 priority/state/labels 的机械更新不需要 base，直接写。

报 conflict 后，把远端当前值与你的意图一起交给用户裁决；执行裁决时把 base 刷新为远端当前值、把 set 改成裁决后的目标，重新 plan/apply。这条路保留 base 保护：裁决与执行之间同事再次修改会再次报 conflict，而不是被静默覆盖。不要为绕过 conflict 改用无 base 的直接更新。

Markdown 正文的比较做等价规范化（换行、行尾空格、列表符号），Linear 的等价改写不会被误判为漂移。

## plan 与 apply

```bash
linear issue plan --file delivery.json            # 零写入预览：字段裁决、条目清单、文件清单
linear issue apply --file delivery.json --confirm-workspace jihuanshe
```

plan 是可选预览，不是强制仪式；apply 自己会重复全部校验。`--confirm-workspace` 必须重复 manifest 里的 workspace，防止把准备好的 manifest 打到错误目标——它不是授权，写入授权始终来自宿主和用户。

apply 逐项返回 applied / failed / unknown / unattempted / skipped，结束后读回每个目标 Issue 的当前视图。

## checkpoint 与续跑

checkpoint 写在 manifest 旁边（`<manifest>.checkpoint.json`），随 manifest 一起交接。每个确认成功的条目按位置加内容哈希记录：续跑跳过它们；修改过失败条目的内容会改变哈希，自动重跑。

续跑期间对 manifest 的安全编辑只有两种：原位修复失败条目，或在末尾追加新条目。在已应用条目之前插入、重排，或删除、改写已应用条目，都会使它们的位置键失配——apply 会拒绝续跑而不是重复已落地的写入；确要重组时，先在 Linear 核实远端状态，再重建或删除 checkpoint。

checkpoint 不是锁：两个执行者同时 apply 同一份 manifest 看不见彼此，每一项都会写两遍。交接是移交执行权，不是复制执行权；同一份 manifest 同一时刻只能有一个执行者。

- `failed`（CLI 明确报错、无远端副作用）：修复后直接重跑，或用 `--continue-on-failure` 让整批先跑完再统一处理。
- `unknown`（进程异常、结果无法判定）：一切续跑被阻塞。先在 Linear 核实该项的远端状态，再编辑或删除 checkpoint 里的对应条目——这个显式对账动作正是 unknown 存在的意义。不要盲目重试：Linear 的 create 没有幂等键，重试可能造成重复。

批量不是事务：中途停止保留已成功的结果，不回滚、不删除重建。
