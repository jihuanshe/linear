---
name: core
title: Command discovery and selection
description: 渐进发现、专用命令优先级、写入授权边界，以及影响命令选择的语义陷阱
keywords:
  - discovery
  - usage
  - help
  - authorization
  - label
  - attachment
  - 发现
  - 授权
  - 标签
  - 附件
commands:
  - usage
  - version
  - auth login
  - auth whoami
  - auth default
  - issue update
  - issue attach
  - issue comment add
  - document update
seeAlso:
  - automation
  - graphql
---

# 命令发现与选择

## 渐进发现，不做仪式

已经知道确切命令就直接执行，不需要先跑 `version`、`usage` 或本指南。不确定时按需下钻，每一步只读当前需要的层级：

```bash
linear                    # 根导航：领域列表
linear issue usage        # 单个领域的命令与选项
linear issue create --help  # 单个命令的完整参考
linear usage --json       # 机器可读的命令树（含 writes/interactive/confirmation 元数据）
```

`usage --json` 中 `writes: true` 表示该命令能修改远端或用户配置的本地状态；这是能力描述，不是授权。宿主与用户策略决定是否允许写入，`--force`、`--yes`、`LINEAR_PROMPT_DISABLED=1` 和 JSON 输出都不构成同意。

## 专用命令 > `linear api` > 直接 HTTP

优先使用专用命令：它们带输入校验、冲突保护和结构化输出。专用命令不覆盖的长尾操作用 `linear api`（见 graphql 指南）。只有需要完整 HTTP 控制时才用 `curl` 加 `linear auth token`。

## 影响命令选择的语义陷阱

- `issue update --label` 和 `project update --label` 替换完整标签集，不是增量添加。先读当前对象，把要保留的标签逐个重新传入。
- 内联图片用 `issue comment add --attach <file>`（上传并渲染在评论正文中）；`issue attach` 创建侧栏 Attachment，不内联渲染。两者是不同的 Linear 对象。
- 上传默认对 workspace 成员私有。`--public` 只接受 PNG/JPEG/GIF/WebP/BMP/TIFF 图片并生成无需登录的公开 URL，其他类型直接失败而不是回退私有；只在用户明确需要公开访问时使用。
- `document update` 会保护含内联评论锚点的内容。未经用户接受锚点可能丢失前，不要用 `--force` 绕过警告。
- Project 的 `description` 字段被 Linear API 限制在 255 字符；长 Markdown 用 project overview 的 `content` / `content-file`。
- workflow state 和用户名不要猜：`linear team states --json` 列出状态，`linear user list --json` 解析成员。

## 认证与访问失败

`linear auth whoami` 是健康探针：成功即认证有效并显示当前 workspace 与用户。失败时的恢复路径都在 CLI 内：

- 缺凭据或 401：让用户在 Linear 的 Security Settings 创建最小权限 personal API key，然后运行 `linear auth login`，把 key 直接输入命令提示符。key 不粘贴进聊天、不写入 shell 历史、不出现在进程参数里。
- 多 workspace：`auth list` 查看已配置的，`auth default` 设默认，单次命令用全局 `--workspace <slug>` 覆盖。
- 无系统 keyring 的环境（容器、部分 VM）：`auth login --plaintext` 落盘存储。
- 经代理访问 GraphQL：设置 `LINEAR_GRAPHQL_ENDPOINT` 环境变量后再登录；认证 header 由代理注入时，login 的 key 只用于建立本地认证状态。

认证失败不能反推二进制来源错误。`linear` 命令本身缺失、被别的安装遮蔽，或组织安装策略问题，不归本 CLI 诊断——回到宿主的引导路由。

## 从已知 URL 定位对象

Linear URL 自带定位信息，不要先列出整个 workspace 再查找。canonical project URL 形态：

```text
https://linear.app/<workspace>/project/<project-name>-<project-slug-id>/issues
```

从路径取 workspace slug 和 project slug ID，先 `linear project view <id> --workspace <slug>` 核对名称，再进行后续查询。核对失败就停止，不把解析结果用于写操作。

## 查询范围

项目可能关联多个 team。项目全量盘点用 `--all-teams`；无法从当前目录配置推断 team 的查询必须显式提供 team scope，不知道 team key 先 `linear team list`。`issue mine` 限定当前认证用户，其他人的或全 team 的用 `issue query`。默认排序是 priority；要保持看板手工顺序显式传 `--sort manual`。
