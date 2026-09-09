# 认证与工作区凭据

CLI 按以下优先级选择认证凭据：

1. 环境变量 `LINEAR_API_KEY`，不能与 `--workspace` 同用；
2. 项目配置中的 `api_key`；
3. `--workspace` 指定工作区的已保存凭据；
4. 项目 `workspace` 配置对应的已保存凭据；
5. 已保存凭据中的默认工作区。

工作区短名对应 API 的 `organization.urlKey`，工作区 UUID 对应 `organization.id`。用 `linear auth whoami --json` 核对当前身份；切换工作区前先排除更高优先级的密钥来源。

## 保存工作区凭据

默认把 API 密钥存入系统密钥环：macOS Keychain、Linux libsecret 或 Windows Credential Manager。工作区列表和默认值保存在凭据文件中：

| 系统                           | 凭据文件                                   |
| ------------------------------ | ------------------------------------------ |
| Unix，已设置 `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/linear/credentials.toml` |
| Unix，未设置 `XDG_CONFIG_HOME` | `$HOME/.config/linear/credentials.toml`    |
| Windows                        | `%APPDATA%\linear\credentials.toml`        |

完整命令以 `linear auth --help` 为准。以下是多工作区的常用流程：

```bash
linear auth login              # 通过提示符输入 API 密钥并保存工作区
linear auth login --plaintext  # 没有系统密钥环时明文保存
linear auth migrate            # 把已有明文密钥迁入系统密钥环
linear auth list               # 查看已配置工作区
linear auth default            # 交互选择默认工作区
linear auth default <slug>     # 直接指定默认工作区短名
linear auth logout <slug>      # 移除工作区凭据
linear auth logout <slug> -f   # 跳过移除确认
linear auth whoami --json      # 核对当前用户和工作区
```

在脚本中，从密钥管理器或 CI 密钥存储向单个进程注入 `LINEAR_API_KEY`。不要把密钥放进命令参数、shell 历史或日志。`linear auth token` 会输出解析后的密钥；只有底层 HTTP 客户端确实需要时，才在受控进程内消费它。

### 添加工作区

第一个工作区自动设为默认值：

```text
$ linear auth login
Enter your Linear API key: ***
Logged in to workspace: Acme Corp (acme)
  User: Jane Developer <jane@acme.com>
  Set as default workspace
```

再次运行 `linear auth login` 可以添加其他工作区。`linear auth list` 中的 `*` 表示默认工作区：

```text
$ linear auth list
  WORKSPACE    ORG NAME      USER
* acme         Acme Corp     Jane Developer <jane@acme.com>
  side-project Side Project  Jane Developer <jane@example.com>
```

### 切换工作区

```bash
# 修改默认工作区。
linear auth default side-project

# 只为本次调用选择工作区。
linear --workspace side-project issue mine
linear --workspace acme auth whoami --json
```

### 凭据文件格式

系统密钥环模式下，凭据文件只保存工作区元数据：

```toml
default = "acme"
workspaces = ["acme", "side-project"]
```

使用 `auth login --plaintext` 或沿用已有明文格式时，API 密钥也会直接保存在此 TOML 文件中。应按密钥文件保护它；系统密钥环可用后，运行 `linear auth migrate` 迁移。CLI 兼容旧明文格式，并在检测到时提示。

### 平台依赖

- macOS 使用系统自带的 `/usr/bin/security` 访问 Keychain。
- Linux 使用 libsecret 的 `secret-tool`。Debian／Ubuntu 安装 `libsecret-tools`，Arch 安装 `libsecret`。
- Windows 使用系统自带的 `advapi32.dll` 访问 Credential Manager。

没有系统密钥环时，可以通过 `LINEAR_API_KEY` 注入密钥，或显式选择 `auth login --plaintext`。

## 环境变量与代理

`LINEAR_API_KEY` 优先于已保存凭据。已设置它时，`linear auth login` 会提示：

```text
Warning: LINEAR_API_KEY environment variable is set.
It takes precedence over stored credentials.
Remove it from your shell config to use multi-workspace auth.
```

要使用已保存的多工作区凭据，先移除当前进程及其启动配置中的 `LINEAR_API_KEY`。`LINEAR_GRAPHQL_ENDPOINT` 可以指定受控代理的 GraphQL 端点；代理不会免除身份核对。认证失败的处理见 `linear guide core`。

## 项目配置

项目可以用 `workspace` 选择已保存的凭据：

```toml
workspace = "acme"
team_id = "ENG"
```

即使默认工作区不同，该项目也会使用 `acme` 的凭据。团队、排序、版本控制与附件设置见[配置](configuration.md)。

项目配置也支持 `api_key`，但它优先于工作区选择，且可能被误提交到版本控制。日常使用 `workspace` 配合 `linear auth login`，不要把密钥写入项目配置。

## 创建 API 密钥

打开 [Linear Security & Access](https://linear.app/settings/account/security)，在 Personal API keys 中选择 Create key，填写用途名称并复制生成的密钥，然后通过 `linear auth login` 的提示符输入。

创建 API 密钥需要成员权限，访客账号不提供此功能。
