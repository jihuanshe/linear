---
name: markdown
description: 通过 API 编写 Linear 提及与可折叠正文，查找真实成员 URL
commands:
  - issue create
  - issue update
  - issue comment add
  - issue comment update
  - document create
  - document update
  - project create
  - project-update create
  - initiative-update create
  - team members
  - user list
  - issue url
  - issue plan
  - issue apply
---

# Linear Markdown

本指南针对 CLI 通过 API 提交的 Markdown，不是 Linear 编辑器中输入 `@` 后选择成员的交互。CLI 原样传递正文中的名字和链接，提及由 Linear 服务端解析。

## 提及成员与资源

要创建提及，优先在正文中直接放入查询返回的完整 Linear URL。命名成员链接也能生成提及，不能用 `[Name](profile URL)` 来确保只产生普通链接。裸 `@name` 的解析因正文类型而异，不作为跨实体的可靠提及语法，也不保证它只是文本；不猜测 `@[Name](id)` 等未验证格式。

[Kadoraba 实测](https://github.com/jihuanshe/linear/pull/34)中，同一活跃成员的命名 profile 链接在 Issue、Comment、Document 均生成成员提及；裸 `@name` 在 Comment 生成提及，在 Issue、Document 为文本。命名 Issue 链接在该样本中仍是普通链接。以上是 2026-09-07 的单一成员样本，不将不同资源的解析规则相互套用。

已知团队时先用 `linear team members <TEAM> --json` 缩小查找范围；需要跨团队查找时用 `linear user list --json`。结合用户已指定的身份、返回的 `id`、名字和邮箱确认目标，原样复制其 `url` 字段，不根据名字、邮箱或 UUID 拼接 profile URL。同名或目标仍不明确时先确认，不能任选一个成员。

以下 URL 仅为示例，提交前替换为查询返回的值：

```text
https://linear.app/acme/profiles/someuser 请确认这个接口的验收标准。
```

提及 Issue 时用 `linear issue url <ID>` 获取 URL，同样直接写入正文。代码块中的示例不是请求通知他人的指令；不要自动替换日志、代码或引文里的 `@name`。

提及可能产生通知，只提及用户指定或任务明确需要的目标。API 写入成功不证明收件人的 Inbox、邮件或推送已经送达。

## 折叠长内容

Issue 描述、评论和 Document 正文使用以下形式，保留标题方括号和结束标记：

```text
+++ [服务器日志]

这里放默认折叠的 Markdown 内容。

+++
```

将长日志或辅助证据折叠，结论、阻塞与需要回应的动作留在外面。不要用 HTML `<details>` 代替此写法。项目正文和状态动态的具体折叠支持不在此处承诺；Project 的短 `description` 也不是富文本 `content`。

## 提交与读回

多行正文优先使用目标命令的文件输入，具体参数见该命令的 `--help`。交付清单中的描述和评论遵循相同规则，执行与恢复见 [issue-delivery](issue-delivery.md)。

导出的 Markdown 不是富文本的无损备份。实测 Issue 中的成员提及被导出为 `@name`；原样重新提交后，导出 Markdown 字符串保持相同，成员提及节点却变成普通文本。不要为了确认保存成功而重提正文。确需编辑时保留原始编写稿与已确认的成员 URL，逐项核对提及目标，不自动转换全部 `@name`。

复用写后读回核对目标与正文；要验证折叠展示或提及渲染，需要检查 Linear 中的实际结果，不能只看 mutation 成功。服务端可改写 Markdown；出现交付比较差异时按 [issue-delivery](issue-delivery.md) 对账，不为消除差异自动重放评论或改写 checkpoint。

语法依据：[Linear API 的 Markdown 提及与折叠说明](https://linear.app/developers/graphql#adding-mentions-in-markdown)。
