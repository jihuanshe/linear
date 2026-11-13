# 安装、认证与配置

## 安装

```bash
mise use -g "github:jihuanshe/linear[minimum_release_age=0s]@latest"
linear --version
```

需要可复现安装时，把 `latest` 换成 [GitHub Releases](https://github.com/jihuanshe/linear/releases/latest) 中的确切版本。已安装的发行版用 `linear update` 更新。

mise 配置钉成确切版本时 `linear update` 会报错，处理方式和交给 AI Agent 的提示词见 [README 的更新章节](../README.md#更新)。

## 认证

在 Linear 的 Settings > Account > Security & Access 创建 Personal API key，再通过提示符登录：

```bash
linear auth login
linear auth whoami --json
```

CLI 按以下顺序选择凭据：

1. 环境变量 `LINEAR_API_KEY`（值原样作为 `Authorization` 请求头；OAuth access token 写作 `Bearer <token>`，见 [README 的「给 AI 配置独立身份」](../README.md#给-ai-配置独立身份)）；
2. 环境变量 `LINEAR_CLIENT_ID` 和 `LINEAR_CLIENT_SECRET`，自动换取临时 OAuth client credentials 令牌；
3. `--workspace` 指定的已保存凭据；
4. 配置 `workspace` 指定的已保存凭据；
5. 已保存凭据中的默认工作区。

`LINEAR_API_KEY` 和 client credentials 都不能与 `--workspace` 同用。使用已保存的多工作区凭据前，先移除对应环境变量。每次切换工作区都运行 `auth whoami --json`，核对 `organization.id` 和 `organization.urlKey`。

Client credentials 要求 Linear OAuth 应用开启 Client credentials，身份为 `actor=app`。通过密钥管理器注入 `LINEAR_CLIENT_ID` 和 `LINEAR_CLIENT_SECRET` 后直接运行命令，无需 `auth login`。两者缺一或为空时报错，不回退到已保存凭据。`LINEAR_CLIENT_SCOPE` 默认 `read`，可设为逗号分隔的 scope（如 `read,write`）；同一应用、工作区的进程应保持 scope 一致，改变 scope 会使已有应用令牌失效。

CLI 在首次认证请求时向 `https://api.linear.app/oauth/token` 换取一个令牌，同一命令的请求共用它；结束时向 `https://api.linear.app/oauth/revoke` 吊销。成功、失败、SIGINT 和 Unix 上的 SIGTERM 都会等待吊销；Windows 强制终止进程和 SIGKILL 无法执行清理。换取与吊销请求各有 10 秒期限，不自动重试。吊销失败时保留命令结果，向 stderr 报告并以非零状态退出；令牌可能仍有效，需要在 Linear 应用页面轮换 Client secret 才能作废该应用的全部 client credentials 令牌。网络中断导致无法取得已签发令牌时也需这样处理。

Linear 的 GraphQL 鉴权可能延迟反映吊销结果；吊销成功后，旧令牌仍可能短暂通过查询。

Client secret 和临时令牌不写入凭据文件、命令参数或诊断输出；`auth key` 在此模式下报错。已有 OAuth access token 仍可通过 `LINEAR_API_KEY` 传入，其吊销由调用方负责。

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

`auth list` 只展示本地凭据库存，实际联网检查用 `auth whoami`。普通命令只读取选中工作区的凭据。迁移已有明文凭据用 `auth migrate`。

脚本和 CI 优先从密钥管理器向单个进程注入 `LINEAR_API_KEY`。CLI 会加载 `.env`；从环境密钥切换到已保存账号前，先检查 `.env`。明文凭据和 `.env` 容易进入源码、备份或日志，不要用于长期共享密钥。`linear auth key` 只在底层 HTTP 客户端确实需要时使用。

配置文件不能保存 `api_key`。已有该字段时，实际读取配置的操作会拒绝执行；先通过 `auth login` 保存并核对密钥，再移除 TOML 中的密钥字段。

## 项目配置

在尚未配置的仓库中运行 `linear config`，交互选择工作区、团队和 Issue 排序，写入 `.linear.toml`。已有配置时直接编辑，向导不覆盖文件：

```toml
workspace = "acme"
team_key = "ENG"
issue_sort = "priority"
issue_create_assign_self = "auto"
issue_create_ask_project = true
vcs = "git"
```

普通设置按「命令选项 → `LINEAR_<KEY>` → 项目 TOML → 用户 TOML → 默认值」选择。项目设置只覆盖写出的 key；认证凭据和工作区选择遵循本页前面的独立顺序。

`team_key` 保存团队可读 key（如 `ENG`），不是团队 UUID；对应环境变量为 `LINEAR_TEAM_KEY`。

显式非法值报错，不按未设置处理。

项目配置使用 `.linear.toml` 或 `.config/linear.toml`。项目根或当前目录有 `linear.toml` 时，读取配置的命令报错；把其中的非密钥设置移到 `.linear.toml`。用户级 `$XDG_CONFIG_HOME/linear/linear.toml`、`$HOME/.config/linear/linear.toml` 和 Windows `%APPDATA%\linear\linear.toml` 不受此项目文件名规则影响。

根导航、帮助、版本、guide 和 recipe 不读取配置、`.env` 或私有凭据，配置损坏时仍可离线查阅。实际使用配置或凭据的命令会报告对应错误。

## 运行时开关

| 变量                       | 作用                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `LINEAR_PROMPT_DISABLED=1` | 禁止提示；缺少输入时失败                                                             |
| `LINEAR_GRAPHQL_ENDPOINT`  | 使用受控 GraphQL 代理；仍需核对身份                                                  |
| `LINEAR_DEBUG=1`           | 在 stderr 输出底层错误和堆栈                                                         |
| `LINEAR_NOW`               | 用带时区的 ISO 8601 时刻固定相对日期的“当前时间”，用于可复现的输出；无效值使命令失败 |
| `NO_COLOR=1`               | 禁止颜色、动画和 OSC-8 链接                                                          |

`--json`（`-j`）是全局输出选项，命令是否支持 JSON 以 `usage --json` 的 `outputModes` 为准；其他选项查看 `linear <command> --help`。无人值守输出、依据比较和写入效果见 `linear guide automation`。
