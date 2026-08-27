# 配置

Linear CLI 从命令 flag、环境变量、项目 TOML 和用户 TOML 解析配置。认证凭据的存储与 workspace 选择另见[认证与 workspace 凭据](authentication.md)。

## 生成项目配置

在目标仓库中运行：

```bash
linear config
```

命令会交互选择 workspace、team 和 Issue 排序，然后写入 Git 根目录；不在 Git 仓库中时则写入当前目录：

- 目标目录已有 `.config/`：`.config/linear.toml`；
- 其他情况：`.linear.toml`。

生成结果只包含该仓库的常用默认值，可以继续手工添加下表中的其他配置。

## 优先级与文件位置

普通设置按以下顺序选择，先出现的已设置值获胜：

1. 目标命令明确映射到该设置的 flag；
2. 当前进程中的 `LINEAR_<TOML_KEY_UPPERCASE>` 环境变量；
3. 第一个找到的项目配置；
4. 用户配置；
5. 命令自身的默认值。

高优先级值会在选中后校验；无效值不会回退到低优先级来源。`issue_sort` 会明确报错，其他设置按目标命令的默认行为处理。

API key 和 `--workspace` 的身份选择有独立的安全优先级，不套用这份普通设置顺序；见[认证与 workspace 凭据](authentication.md)。

项目配置按以下顺序寻找，只读取第一个存在的文件：

1. 当前目录的 `linear.toml`；
2. 当前目录的 `.linear.toml`；
3. Git 根目录的 `linear.toml`；
4. Git 根目录的 `.linear.toml`；
5. Git 根目录的 `.config/linear.toml`。

用户配置在 Unix 使用 `$XDG_CONFIG_HOME/linear/linear.toml`，未设置 `XDG_CONFIG_HOME` 时使用 `~/.config/linear/linear.toml`；Windows 使用 `%APPDATA%\linear\linear.toml`。项目配置按 key 覆盖用户配置，未提及的用户设置继续生效。

CLI 还会读取当前目录的 `.env`；不存在时再读取 Git 根目录的 `.env`。只接受 `LINEAR_`、`GH_` 和 `GITHUB_` 前缀，且不会覆盖当前进程已经设置的环境变量。不要把 API key 提交进项目配置或 `.env`。

## 设置

| TOML key                    | 环境变量                           | 取值与作用                                                                                        |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `workspace`                 | `LINEAR_WORKSPACE`                 | 默认 workspace slug；从已保存凭据中选择对应 key                                                   |
| `team_id`                   | `LINEAR_TEAM_ID`                   | 默认 team key，例如 `ENG`                                                                         |
| `issue_sort`                | `LINEAR_ISSUE_SORT`                | `priority`（默认）或 `manual`                                                                     |
| `issue_create_ask_project`  | `LINEAR_ISSUE_CREATE_ASK_PROJECT`  | 创建 Issue 时是否询问 project                                                                     |
| `issue_create_assign_self`  | `LINEAR_ISSUE_CREATE_ASSIGN_SELF`  | `always`、`auto`（默认）或 `never`                                                                |
| `vcs`                       | `LINEAR_VCS`                       | `git`（默认）或 `jj`                                                                              |
| `download_images`           | `LINEAR_DOWNLOAD_IMAGES`           | 以非 JSON 输出查看 Issue／Document 时是否下载 Markdown 内联图片；默认开启                         |
| `auto_download_attachments` | `LINEAR_AUTO_DOWNLOAD_ATTACHMENTS` | 以非 JSON 输出查看 Issue 时是否下载 Linear file Attachment；默认开启，并受 `download_images` 控制 |
| `attachment_dir`            | `LINEAR_ATTACHMENT_DIR`            | Attachment 下载目录；默认使用系统临时目录下的 `linear-cli-attachments`                            |
| `hyperlink_format`          | `LINEAR_HYPERLINK_FORMAT`          | TTY 中本地文件 OSC-8 链接模板；支持 `{host}` 和 `{path}`，`default` 等于 `file://{host}{path}`    |

布尔配置接受 `true`／`false`、`yes`／`no`、`y`／`n`、`on`／`off`、`1`／`0` 和 `t`／`f`，不区分大小写。

示例：

```toml
workspace = "acme"
team_id = "ENG"
issue_sort = "priority"
issue_create_assign_self = "auto"
issue_create_ask_project = true
vcs = "jj"
download_images = true
auto_download_attachments = false
hyperlink_format = "file://{host}{path}"
```

## 独立环境开关

以下变量不是 TOML 设置：

| 环境变量                   | 作用                                             |
| -------------------------- | ------------------------------------------------ |
| `LINEAR_PROMPT_DISABLED=1` | 禁止所有交互提示；缺少输入时失败，不代表授权写入 |
| `LINEAR_GRAPHQL_ENDPOINT`  | 覆盖 GraphQL endpoint，用于受控代理              |
| `LINEAR_DEBUG=1`           | 在 stderr 输出底层错误和 stack trace             |
| `NO_COLOR=1`               | 禁止颜色、spinner 和 OSC-8 链接等 TTY 样式       |

每个命令支持的显式 flag 和运行时默认值以 `linear <command> --help` 为准；无人值守输出契约见 `linear guide automation`。
