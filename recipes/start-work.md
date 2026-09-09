# 建立工作上下文并更新 Issue 状态

需要先创建 Git 分支或 Jujutsu change，再把 Issue 置于指定状态时使用。选择任务可先用 `linear issue pick`，它只输出编号。

执行需要 Deno、当前 `linear`，以及所选的 Git 或 Jujutsu。`LINEAR_BIN` 可以固定 CLI 的绝对路径。脚本会修改本地 VCS 和远端 Issue，需要当前任务授权这两个动作。

```sh
linear recipe start-work --source > start-work.js
deno run --allow-run --allow-env --allow-read --allow-write start-work.js \
  git ENG-123 feature/eng-123 work-base.json 'In Progress' main
# Jujutsu 的 context 参数是描述，不是分支名。
deno run --allow-run --allow-env --allow-read --allow-write start-work.js \
  jj ENG-123 'Implement login' jj-base.json 'In Progress' @
```

脚本先保存 Issue 原始读取，再运行 `git switch -c` 或 `jj new -m`，最后用同一依据更新状态。依据文件必须不存在；脚本不自动复用现有分支或 change。

本地创建成功而状态更新失败时，保留已经创建的分支或 change。检查输出，按原始依据单独调用 `issue update`，不要重跑完整步骤。结果未知时先对账；这不是跨系统事务，也没有自动恢复。

创建新 Issue 后同样显式选择后续步骤，`issue create` 不自动设置 VCS 或开始工作。
