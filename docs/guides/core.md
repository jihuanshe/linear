---
name: core
description: 渐进发现、typed command 与 GraphQL 的分工、写入授权边界，以及影响命令选择的语义陷阱
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
---

# 命令发现与选择

## 渐进发现，不做仪式

已经知道确切命令就直接执行，不需要先跑 `version`、`usage` 或本指南。不确定时按需下钻，每一步只读当前需要的层级：

```bash
linear                    # 根导航：领域列表
linear issue usage        # 单个领域的命令与选项
linear issue comment usage  # 任意嵌套命令组的命令与选项
linear issue create --help  # 单个命令的完整参考
linear usage --json       # 机器可读的命令树（含 writes/interactive/confirmation 元数据）
```

`usage --json` 中 `writes: true` 表示该命令能修改远端状态或本地的用户配置。这是能力描述，不是授权：是否允许写入由宿主（运行本 CLI 的 agent 环境及其权限系统）与用户决定，`--force`、`--yes`、`LINEAR_PROMPT_DISABLED=1` 和 JSON 输出都不构成同意。

## 按责任选择专用命令、GraphQL 与 HTTP

常见领域操作、名称解析和安全写入优先使用专用命令；输入校验、冲突保护和结构化输出等具体保障以目标命令的 `--help` 与指南为准。精确字段选择、批量正文、少见 filter 和跨实体只读查询直接使用 `schema` + `linear api`（见 graphql 指南），不要为了临时读取形状扩建命令面。只有需要完整 HTTP 控制时才降级到直接 HTTP，凭据处理见 graphql 指南。

`linear api` 也能发送 mutation，但不拥有专用写命令的名称解析、增量更新、冲突保护或写后核算。存在专用写命令时不要改用 raw mutation 绕过其边界。

## 留下原语，组合交给临时脚本

命令名相近不代表责任相同。稳定命令负责一个资源或一个明确的协议边界；一次性跨对象组合由 [automation](automation.md) 指南中的临时脚本编排，不为它增加永久命令。

| 需求                 | 优先使用                                                | 不要混用                               |
| -------------------- | ------------------------------------------------------- | -------------------------------------- |
| 按多个条件读取任务   | `issue query`                                           | 不为每种筛选组合新增命令               |
| 修改一个任务         | `issue update`                                          | 不用 raw mutation 绕过名称解析和校验   |
| 修改项目本身         | `project update`                                        | 不要把项目状态更新当成 Project 字段    |
| 发布项目状态更新     | `project-update create/list`                            | 不要用 `project update` 代替 Pulse     |
| 一批任务使用相同补丁 | 由临时脚本逐条调用 `issue update`，保留命令的解析和校验 | 不用 `issueBatchUpdate` 绕过专用写命令 |

`issue mine` 仍是带默认待办范围以及 `--web` / `--app` 的便利入口。需要明确筛选、跨团队读取或机器处理时，改用 `issue query --assignee self`，跨团队再加 `--all-teams`。`initiative update` 与 `initiative-update create/list` 也分别对应 Initiative 本身和状态更新，不能仅按名称合并。

## 影响命令选择的语义陷阱

- `issue update --label` 和 `project update --label` 替换完整标签集，不是增量添加；增量加标签用 `issue update --add-label`。用 `--label` 时先读当前对象，把要保留的标签逐个重新传入。
- 内联图片和侧栏 Attachment 是两个不同的 Linear 对象。`issue comment add --attach <file>` 上传文件并渲染在评论正文中；`issue attach` 创建侧栏 Attachment，不内联渲染。
- 上传默认对 workspace 成员私有。`--public` 只接受 PNG/JPEG/GIF/WebP/BMP/TIFF 图片并生成无需登录的公开 URL，其他类型直接失败而不是回退私有；只在用户明确需要公开访问时使用。
- `document update` 会保护含内联评论锚点的内容。用户明确接受「锚点可能丢失」这一风险之前，不要用 `--force` 绕过警告。
- Project 的 `description` 字段被 Linear API 限制在 255 字符；长 Markdown 用 project overview 的 `content` / `content-file`。
- workflow state 和用户名不要猜：`linear team states --json` 列出状态，`linear user list --json` 解析成员。
- `issue query --state` 按 Linear 的状态类型过滤（如 `started`）；只匹配团队工作流中的精确状态名用可重复的 `--state-name`（如 `Merged`）。

## 认证与访问失败

`linear auth whoami` 是健康探针：成功即认证有效并显示当前 workspace 与用户。失败时的恢复路径都在 CLI 内：

- 缺凭据或 401：让用户在 Linear 的 Settings > Account > Security & Access 页面创建最小权限 personal API key，然后运行 `linear auth login`，把 key 直接输入命令提示符。key 不粘贴进聊天、不写入 shell 历史、不出现在进程参数里。
- 多 workspace：`auth list` 查看已配置的，`auth default` 设默认，单次命令用全局 `--workspace <slug>` 覆盖。
- 无系统 keyring 的环境（容器、部分 VM）：`auth login --plaintext` 落盘存储。
- 经代理访问 GraphQL：设置 `LINEAR_GRAPHQL_ENDPOINT` 环境变量后再登录；认证 header 由代理注入时，login 的 key 只用于建立本地认证状态。

认证失败不能反推二进制来源错误。`linear` 命令缺失、被别的安装遮蔽或组织安装策略问题不归本 CLI 诊断，应报告给安装这个二进制的宿主环境或用户，按其安装文档处理。

## 从已知 URL 定位对象

Linear URL 自带定位信息，不要先列出整个 workspace 再查找。canonical project URL 形态：

```text
https://linear.app/<workspace>/project/<project-name>-<project-slug-id>/issues
```

从路径取 workspace slug 和 project slug ID，先 `linear project view <id> --workspace <slug>` 核对名称，再进行后续查询。核对失败就停止，不把解析结果用于写操作。

## 查询范围

- 项目可能关联多个 team，项目全量盘点用 `--all-teams`。
- CLI 从 `linear config` 保存的配置或当前目录名推断默认 team。推断不出时，查询必须显式提供 team scope；不知道 team key 先 `linear team list`。
- `issue mine` 限定当前认证用户，其他人的、全 team 的或机器处理的用 `issue query`。
- 默认排序是 priority；要保持看板手工顺序显式传 `--sort manual`。
