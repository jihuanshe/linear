# 内嵌工作流示例

Recipe 是可修改的工作流示例：说明何时使用、需要什么工具、会产生哪些副作用，以及失败后如何处理，并提供实际脚本源码。使用已安装的 CLI 获取即可，不需要 clone 仓库。

```sh
linear recipe                         # 只列名称与用途
linear recipe --json                  # AI 可消费的简短目录
linear recipe guarded-edit            # 读取所选示例的完整说明
linear recipe guarded-edit --json     # 一次取得说明、文件名与源码
linear recipe guarded-edit --source > guarded-edit.js
```

说明和源码静态嵌入二进制，与已安装的 CLI 一起分发；读取不访问网络或执行脚本。具名 JSON 包含 `name`、`description`、`filename`、`body` 和 `source`。只需脚本字节时使用 `--source`，不要解析人类说明或 JSON。

执行导出的文件需要说明中列出的运行时和工具，例如 Deno、Git、Jujutsu 或 GitHub CLI。`LINEAR_BIN=/absolute/path/to/linear` 可以固定同一 CLI。脚本通过命令参数、文件和 JSON 交互，不导入内部源码；用户可以修改自己的工作策略。脚本源码不构成写入授权，执行副作用仍由当前任务授权。

CLI 的操作、校验和写入结果是稳定边界；Recipe 只组合这些操作。需要 Issue 批量交付与自动恢复时，使用 `linear guide issue-delivery` 描述的清单和执行账本，不在示例里复制恢复引擎。

## 维护

每个示例的说明在同名 Markdown，脚本在 `.js` 或 `.sh` 文件中。名称、简短用途和静态导入由 `src/recipes/catalog.ts` 统一拥有；命令入口只负责列出、读取和输出源码。新增或删除示例时同步该清单，测试核对磁盘文件、内嵌内容和命令输出。

测试必须包含脱离源码仓库后的消费路径：从确切编译二进制取得脚本，在独立目录检查依赖和执行行为。仓库内测试通过不能单独证明安装用户可用。
