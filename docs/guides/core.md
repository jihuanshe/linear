---
name: core
description: 选择命令、核对 workspace、确定查询范围与写入授权
commands:
  - usage
  - version
  - auth login
  - auth whoami
  - auth default
  - issue update
  - issue attach
  - issue comment add
  - project view
  - document update
---

# 命令发现与选择

已知命令直接执行；不确定时按需查看：

```bash
linear                       # 领域导航
linear issue usage           # 领域命令与选项
linear issue comment usage   # 嵌套命令组
linear issue create --help   # 单命令参考
linear usage --json          # 命令树与能力元数据
```

## 选择入口

常见操作用专用命令；精确字段、少见筛选和跨实体查询用 `linear api`。只有专用命令未覆盖的写入才用 raw mutation，不绕过已有命令的名称解析、输入校验、冲突保护或读回。GraphQL 与直接 HTTP 的用法见 [graphql](graphql.md)。

组合正文、评论、附件等执行项用 [issue-delivery](issue-delivery.md)；其他跨命令任务用 [automation](automation.md) 编排。

以下名称相近，但操作不同：

- `project update` 修改项目，`project-update create/list` 发布或读取项目进展；`initiative update` 与 `initiative-update create/list` 同理。
- Project `description` 是短简介，长正文属于 overview。创建时用 `project create --content-file`；`project update` 尚不支持 overview，更新它需用 `linear api`。
- `issue update --label` 和 `project update --label` 替换完整标签集。只给 Issue 增删标签用 `--add-label/--remove-label`；替换前读全现有标签并保留仍需要的项。
- `issue comment add --attach` 把文件嵌入评论，`issue attach` 创建侧栏 Attachment。材料放置见 [issue-authoring](issue-authoring.md)。

## 授权与身份

用户明确要求按给定内容创建或修改即构成授权，无需重复确认；调查、查看和起草不授权写入。只在未决信息会改变目标、责任、访问范围或业务结果时展示草稿或变更摘要并确认，措辞细节直接处理。

`writes: true` 表示命令能修改远端状态或本地配置。能力元数据、`--force`、`--yes`、禁用提示和 JSON 输出都不构成授权。`document update --force` 会绕过内联评论锚点保护，使用前需用户接受锚点丢失风险。

用与后续命令相同的凭据和 workspace 参数运行 `auth whoami --json`，核对返回的 `organization.urlKey`：

- 使用已存凭据时，`auth list` 查看 workspace，`--workspace <slug>` 选择单次命令的身份；无需修改默认值。
- `LINEAR_API_KEY` 与 `--workspace` 冲突；配置中的 `api_key` 优先于 `--workspace`。使用这两种 key 时，不带 `--workspace` 核对其身份；切换到已存凭据前须排除这两种来源。
- 缺凭据或 401 时，通过 `auth login` 提示符输入 key，不粘贴进聊天或命令行；无系统 keyring 时用 `--plaintext`。代理 endpoint 由 `LINEAR_GRAPHQL_ENDPOINT` 指定，登录仍须验证身份。

身份不匹配或认证失败时，停止依赖该凭据的操作。

## 从 URL 定位对象

已知 Linear URL 时直接取定位信息，不先列出整个 workspace。项目 URL：

```text
https://linear.app/<workspace>/project/<project-name>-<project-slug-id>/issues
```

取 workspace slug 和 project slug ID，按上述认证规则核对身份，再用 `project view <id>` 核对对象。读取 overview 加 `--include-content --json`。

## 确定查询范围

`issue query --project` 默认覆盖项目关联的全部团队；显式 `--team` 会缩窄结果。没有项目范围时，默认团队来自 `LINEAR_TEAM_ID` 或配置 `team_id`（环境变量优先），不从目录名推断。查询整个 workspace 用 `--all-teams`；未知团队用 `team list` 查找。

个人待办用 `issue mine`；需要筛选或机器输出时用 `issue query --assignee self`。`--state` 匹配状态类型，如 `started`；`--state-name` 匹配工作流名称，如 `Merged`。状态和成员分别用 `team states --json`、`user list --json` 查询。

按外部对象 URL 查重用 `issue query --url` 或 `--url-file`，不能用 `--search` 的相关性结果证明不存在。精确匹配与分页边界见 [automation](automation.md)。
