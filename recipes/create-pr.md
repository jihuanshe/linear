# 从 Issue 创建 GitHub PR

已有代码分支和 PR 正文，想用 Issue 编号与标题作为 PR 标题时使用。脚本读取 Issue 的标题和 URL，再调用原生 `gh pr create`。

执行需要 POSIX shell、当前 `linear` 和已登录的 `gh`。`LINEAR_BIN` 可以固定 CLI 的绝对路径。创建 PR 是 GitHub 写入，需要当前任务授权；脚本不会 commit、push 或修改 Issue。

```sh
linear recipe create-pr --source > create-pr.sh
linear issue view ENG-123 --json > issue.json
# 编写 pr-body.md，包含可独立理解的改动说明和 Issue URL。
sh create-pr.sh ENG-123 owner/repo pr-body.md --draft --base main
```

前三个参数是 Issue、GitHub 仓库和已有正文文件，其余参数直接交给 `gh pr create`。默认标题为编号加 Issue 标题；正文由调用者准备，脚本不会把 Issue 描述自动当成代码改动说明。

gh 返回不确定结果时，先用 `gh pr list` 或 `gh pr view` 核对是否已经创建，不能直接重试。需要不同标题或关联策略时修改导出的脚本，或直接组合原生命令。
