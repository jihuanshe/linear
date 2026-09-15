# 安装、认证与配置

## 安装

```bash
mise use -g "github:jihuanshe/linear[minimum_release_age=0s]@latest"
linear --version
```

需要可复现安装时，把 `latest` 换成 [GitHub Releases](https://github.com/jihuanshe/linear/releases/latest) 中的确切版本。已安装的发行版用 `linear update` 更新。

## 认证

在 Linear 的 Settings > Account > Security & Access 创建 Personal API key，再通过提示符登录：

```bash
linear auth login
linear auth whoami --json
```

CLI 按以下顺序选择凭据：

1. 环境变量 `LINEAR_API_KEY`；
2. 项目配置中的 `api_key`；
3. `--workspace` 指定的已保存凭据；
4. 项目 `workspace` 指定的已保存凭据；
5. 已保存凭据中的默认工作区。

`LINEAR_API_KEY` 不能与 `--workspace` 同用。使用已保存的多工作区凭据前，先移除环境变量。每次切换工作区都运行 `auth whoami --json`，核对 `organization.id` 和 `organization.urlKey`。认证成功不代表目标对象属于预期工作区。

默认凭据存入系统密钥环；工作区列表和默认值存入凭据文件：

| 系统                           | 文件                                       |
| ------------------------------ | ------------------------------------------ |
| Unix，设置 `XDG_CONFIG_HOME`   | `$XDG_CONFIG_HOME/linear/credentials.toml` |
| Unix，未设置 `XDG_CONFIG_HOME` | `$HOME/.config/linear/credentials.toml`    |
| Windows                        | `%APPDATA%\linear\credentials.toml`        |

```bash
linear auth login --plaintext  # 没有系统密钥环时明确选择明文存储
linear auth migrate            # 把已有明文密钥迁入系统密钥环
linear auth list
linear auth default <workspace>
linear auth logout <workspace>
```

脚本和 CI 优先从密钥管理器向单个进程注入 `LINEAR_API_KEY`。CLI 也支持项目配置、明文凭据和 `.env`；这些来源容易进入源码、备份、参数或日志，不要用于长期共享密钥。`linear auth token` 只在底层 HTTP 客户端确实需要时使用。

## 项目配置

在仓库中运行 `linear config`，交互选择工作区、团队和 Issue 排序。命令写入 `.linear.toml` 或 `.config/linear.toml`。也可以手写：

```toml
workspace = "acme"
team_id = "ENG"
issue_sort = "priority"
issue_create_assign_self = "auto"
issue_create_ask_project = true
vcs = "git"
download_images = true
auto_download_attachments = false
```

普通设置按「命令选项 → `LINEAR_<KEY>` → 项目 TOML → 用户 TOML → 默认值」选择。项目设置只覆盖写出的 key；认证凭据和工作区选择遵循本页前面的独立顺序。

可用设置以 `linear config --help` 和命令帮助为准。常用 key 包括 `workspace`、`team_id`、`issue_sort`、`vcs`、`download_images`、`auto_download_attachments`、`attachment_dir` 和 `hyperlink_format`。

## 运行时开关

| 变量                       | 作用                                     |
| -------------------------- | ---------------------------------------- |
| `LINEAR_PROMPT_DISABLED=1` | 禁止提示；缺少输入时失败，不代表授权写入 |
| `LINEAR_GRAPHQL_ENDPOINT`  | 使用受控 GraphQL 代理；仍需核对身份      |
| `LINEAR_DEBUG=1`           | 在 stderr 输出底层错误和堆栈             |
| `NO_COLOR=1`               | 禁止颜色、动画和 OSC-8 链接              |

`--json`（`-j`）是全局输出选项，命令是否支持 JSON 以 `usage --json` 的 `outputModes` 为准；其他选项查看 `linear <command> --help`。无人值守输出、依据比较和写入效果见 `linear guide automation`。
