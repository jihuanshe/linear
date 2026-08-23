# 仓库工作流

## 事实源

| 关注事项                     | 来源                                        |
| ---------------------------- | ------------------------------------------- |
| 运行时版本与开发任务         | `mise.toml`、`deno.json`                    |
| Orb 引导与源码包装器         | `.agents/setup`、`.agents/resume`           |
| Linear GraphQL schema 与生成 | `graphql/schema.graphql`、`codegen.ts`      |
| 生产代码与对应测试           | `src/`、`test/`                             |
| Deno 权限变更                | `docs/deno-permissions.md`                  |
| 内嵌工作流指南               | `docs/guides/`、`src/guides/`               |
| 发布流程                     | `.agents/skills/releasing/SKILL.md`         |
| Pull Request 源码验证        | `.github/workflows/verify-pull-request.yml` |
| CI 发布实现                  | `.github/workflows/ship-main.yml`           |

`AGENTS.md` 是仓库指导源。`CLAUDE.md` 仅作为指向本文件的兼容性指针。

## 开发循环

1. 使用 Deno `2.9.4`。在 Orb 中，生命周期脚本会在 `$HOME/workspace/repo` 配置专用的主 checkout，并通过 Orb 管理的 `~/.local/bin` 条目将其 `deno` 和基于源码的 `linear` 命令发布到稳定的命令 PATH；只有在工具链缺失或损坏时才运行 `.agents/setup`。在其他环境中使用 `mise install`。
2. 编辑前阅读所属模块及其对应测试。命令测试遵循源码路径，例如 `src/commands/issue/issue-view.ts` 对应 `test/commands/issue/issue-view.test.ts`。
3. 行为发生变化时新增或更新测试。使用 `deno task test`；只有在有意更新快照时才使用 `deno task update-snapshots`。快照测试设置 `NO_COLOR=1`。
4. 修改 `graphql/schema.graphql` 或 `src/` 中的 `gql` 文档后，运行 `deno task generate-graphql-types`。生成的 GraphQL 文件会被忽略，不得提交。
5. 修改命令树或 `docs/guides/` 后运行指南测试；指南 frontmatter 负责维护命令与指南的关系，并由实时命令树进行验证。
6. 开发期间运行范围最小的相关测试或诊断。使用 `deno check`、`deno lint` 和 Deno 任务；不要使用 `tsc` 或依赖 LSP 诊断。

## Kadoraba 实时 API 实验

`LINEAR_KADORABA_API_KEY` 可能作为专用凭据提供，用于在 Kadoraba 测试 workspace 中进行实验。当正确性依赖未文档化或不确定的 Linear API 行为，且确定性的本地测试无法解决问题时，优先进行范围受限的实时实验，而不是凭猜测判断。

- 凭据的存在只表示已认证，不表示获得修改 Linear 的授权。请求当前实验的明确授权，并说明为什么需要实时 API 证据，以及实验会影响哪些对象或行为。
- 用户授权该范围后，无需在每条命令前再次询问即可运行必要的破坏性测试。若要扩展到其他 workspace、共享的既有数据、预期外的成本或停机，或扩展到无法清理的资源，必须再次询问。
- 只检查专用凭据是否存在。绝不打印、推导、指纹化、比较或以其他方式检查凭据内容；在 Kadoraba 实验中也绝不读取、使用或回退到已有的 `LINEAR_API_KEY`。
- CLI 要求使用 `LINEAR_API_KEY` 时，仅为单个进程映射测试凭据：`env LINEAR_API_KEY="$LINEAR_KADORABA_API_KEY" <linear-command>`。
- 第一次 mutation 前，使用同一个可执行文件运行 `auth whoami --json`。只有当 `organization.name` 为 `Kadoraba` 或 `organization.urlKey` 为 `kadoraba` 时才能继续；任何其他身份都必须立即停止。
- 为测试对象使用唯一名称，优先修改实验创建的对象而不是共享对象。通过生产 CLI 入口清理，等待传播延迟，并对最终状态进行结构化验证。报告所有无法删除的对象或资源。
- 除非实验主题就是上传行为，否则避免单独上传，因为 CLI 没有对应的删除命令。
- 对 Pull Request 的验收必须测试确切的目标提交。运行 `deno task install`，并使用绝对路径调用编译后的二进制；Orb 中 `PATH` 上的 `linear` 是源码包装器，不是已安装的产物。
- 不要通过中断 mutation 请求或破坏认证、网络来人为制造实时 `unknown` 结果。除非用户明确授权范围受限的实时实验及其对账计划，否则使用确定性的故障注入测试覆盖这些路径。

## 实现契约

- 优先使用静态导入。只有确有必要时才使用动态导入。
- 避免使用 `any`。让 GraphQL 请求结果保持推断；`client.request(query, variables)` 不应需要显式结果类型。
- 优先使用 `foo == null` 和 `foo != null`，不要分别检查 `undefined`。
- 使用 `@std/fmt/colors` 设置终端样式。
- 在 `--json` 输出中保留 GraphQL 字段名称和嵌套结构。分页 JSON 保留 connection 结构、拼接 `nodes`，不扁平化或重命名字段。
- 添加短选项前搜索全局选项和命令选项；Cliffy 会优先解析全局别名。
- 显式的无效输入必须失败并给出指引，绝不能回退或静默失败。
- 使用 `src/utils/errors.ts` 中的 `ValidationError`、`NotFoundError`、`AuthError` 或 `CliError`。使用 `handleError(error, "Failed to <action>")` 包装命令 action。
- 错误输出到 stderr，并带有 `✗` 前缀。堆栈跟踪需要 `LINEAR_DEBUG=1`。
- 修改 Deno 权限时，遵循 `docs/deno-permissions.md` 中的清单与搜索流程。

## 验证与发布

- `deno task verify-source` 是源码验证任务：生成 GraphQL 类型、检查格式、运行 lint、类型检查以及所有非 Keyring 测试。
- `deno task verify-release` 是完整的本地发布门禁和 Pull Request 源码门禁；它会运行源码验证，而源码验证已经包含内嵌指南契约的检查。
- 未经用户明确授权，不得 push 或发布。用户要求 ship 时，加载并遵循 `.agents/skills/releasing/SKILL.md`；它是唯一的发布流程。
- CI 发布工作流有意不重复本地发布门禁。它会运行 Linux Keyring 集成测试、构建五个平台、验证发布资源、进行证明并发布 GitHub Release。
- 滚动发布任务会串行运行，不取消进行中的任务，最多保留 100 个待处理的 `main` 更新，并为每次成功运行发布独立 Release。
