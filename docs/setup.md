# 安装、认证与配置

## 安装

```bash
mise use -g "github:jihuanshe/linear[minimum_release_age=0s]@latest"
linear --version
```

需要可复现安装时，把 `latest` 换成 [GitHub Releases](https://github.com/jihuanshe/linear/releases/latest) 中的确切版本。已安装的发行版用 `linear update` 更新。

mise 配置钉成确切版本时 `linear update` 会报错，处理方式和交给 AI Agent 的提示词见 [README 的更新章节](../README.md#更新)。

### Orb setup

Linux x86_64、Linux aarch64／arm64 和 macOS arm64 可以使用 Release 资产 `install.sh`。依赖 Bash、curl、tar（支持 xz）及 `sha256sum` 或 `shasum`。在各仓库 `.agents/setup` 的其他 PATH 初始化之后加入：

```bash
if ! (
  installer="$(mktemp)" || exit 1
  trap 'rm -f "$installer"' EXIT
  curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 120 --retry 2 --retry-max-time 180 \
    --output "$installer" https://github.com/jihuanshe/linear/releases/latest/download/install.sh || exit 1
  bash "$installer" --strict
) >/dev/null 2>&1; then
  printf 'WARN: Linear CLI bootstrap failed; continuing setup\n' >&2
fi
```

安装器匿名解析当刻 Latest 的确切 tag，并下载同 tag 的平台归档和 `.sha256`；校验和、文件名、二进制版本及最低版本全部通过后，原子替换 `~/.local/bin/linear`。它在 Bash 实际使用的首个 login 文件（`.bash_profile`、`.bash_login`、`.profile`，均不存在时创建 `.bash_profile`）末尾维护一条 local bin 优先的 PATH，每次执行都会将该行移到最后，并验收当前目录和 HOME 中的新 login shell。

默认下限为 `0.0.1794558300-g5800a29`。`LINEAR_MIN_VERSION=<tag>` 或 `bash install.sh --min-version <tag>` 可以提高下限。成功时没有输出；失败时只向 stderr 输出一行 `WARN: Linear CLI <stage> failed; continuing setup`，保留旧入口并返回 0。`--strict` 使失败返回 1；上面的 wrapper 使用此模式统一收口下载或安装失败，setup 继续执行。修复失败阶段后重新运行 wrapper 即可。

安装事务使用 `~/.local/bin/.linear-install.lock` 目录锁，重叠调用在 `lock` 阶段失败。PATH 文件与二进制在同一锁内验收，失败时恢复两者。进程被 SIGKILL 等强制终止后，先确认没有安装器仍在运行，再检查遗留的 `.linear-install.*`、login 文件旁的 `.linear-profile.*` 中的 `previous` 备份，恢复需要的文件，最后用 `rmdir ~/.local/bin/.linear-install.lock` 解除锁并重试。

Release 同时提供 `install.sh.sha256`；需要独立检查脚本时，从同一确切 tag 下载这两个文件后执行 `sha256sum --check install.sh.sha256`。

## 认证

在 Linear 的 Settings > Account > Security & Access 创建 Personal API key，再通过提示符登录：

```bash
linear auth login
linear auth whoami --json
```

CLI 按以下顺序选择凭据：

1. 环境变量 `LINEAR_API_KEY`（值原样作为 `Authorization` 请求头；OAuth access token 写作 `Bearer <token>`，见 [README 的「给 AI 配置独立身份」](../README.md#给-ai-配置独立身份)）；
2. `--workspace` 指定的已保存凭据；
3. 配置 `workspace` 指定的已保存凭据；
4. 已保存凭据中的默认工作区；
5. 环境变量 `LINEAR_CLIENT_ID` 和 `LINEAR_CLIENT_SECRET`，自动换取临时 OAuth client credentials 令牌。

`LINEAR_API_KEY` 不能与 `--workspace` 同用。已保存的登录凭据优先于 client credentials，即使环境中同时存在 client id／secret。显式选择的工作区不存在、已保存凭据损坏或密钥环读取失败时直接报错，不切换到 app 身份。每次切换工作区都运行 `auth whoami --json`，核对 `organization.id` 和 `organization.urlKey`。

本地存在凭据但没有有效默认工作区时，用 `--workspace` 或 `linear auth default <workspace>` 选择身份。

Client credentials 要求 Linear OAuth 应用开启 Client credentials，身份为 `actor=app`。在没有已保存登录凭据的运行环境中，通过密钥管理器注入 `LINEAR_CLIENT_ID` 和 `LINEAR_CLIENT_SECRET` 后直接运行命令，无需 `auth login`。选中此模式后，两者缺一或为空时报错。`LINEAR_CLIENT_SCOPE` 默认 `read`，可设为逗号分隔的 scope（如 `read,write`）；同一应用、工作区的进程应保持 scope 一致，改变 scope 会使已有应用令牌失效。

App 身份的 mutation 失败时，stderr 会说明身份来自 `LINEAR_CLIENT_ID`；只有 `read` scope 时标明只读，并提示设置 `LINEAR_API_KEY` 或运行 `linear auth login` 切换身份。JSON 错误、原生 GraphQL 回执与写入效果仍保留在 stdout。

CLI 在首次认证请求时向 `https://api.linear.app/oauth/token` 换取一个令牌，同一命令的请求共用它；结束时向 `https://api.linear.app/oauth/revoke` 吊销。成功、失败、SIGINT 和 Unix 上的 SIGTERM 都会等待吊销；Windows 强制终止进程和 SIGKILL 无法执行清理。换取与吊销请求各有 10 秒期限，不自动重试。吊销失败时保留命令结果，向 stderr 报告并以非零状态退出；令牌可能仍有效，需要在 Linear 应用页面轮换 Client secret 才能作废该应用的全部 client credentials 令牌。网络中断导致无法取得已签发令牌时也需这样处理。

收到 SIGINT 或 SIGTERM 后立即停止派发新请求，包括分页、查询重试和后续写入；已发出的请求在进程退出前仍可接收回执。`issue apply` 的恢复边界见[执行账本与恢复](guides/issue-delivery.md#执行账本与恢复)。

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
