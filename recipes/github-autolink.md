# 配置 GitHub 的 Linear 编号链接

想让指定 GitHub 仓库中的 `ENG-123` 一类编号链接到 Linear 时使用。仓库、团队 key 和工作区短名都显式传入，不从当前目录猜测。

执行需要 POSIX shell 和已登录、具有目标仓库配置权限的 `gh`。这会修改 GitHub 仓库配置，需要当前任务授权；不修改 Linear 数据。

```sh
linear recipe github-autolink --source > github-autolink.sh
sh github-autolink.sh owner/repo ENG workspace-url-key
```

脚本调用 `gh api --method POST` 创建自动链接规则。重复运行不会自动查重；执行前可以用 `gh api repos/owner/repo/autolinks` 检查已有规则。请求结果未知时先查已有规则，再决定是否重试。
