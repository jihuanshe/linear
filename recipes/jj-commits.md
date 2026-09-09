# 按 Issue 编号查看 Jujutsu 提交

提交描述使用 `Linear-issue:` trailer，想读取某个 Issue 对应的 change 和 diff 时使用。脚本只读取 Linear 和 Jujutsu，不写数据。

执行需要 Deno、当前 `linear` 和 Jujutsu；在目标 Jujutsu 工作目录运行。`LINEAR_BIN` 可以固定 CLI 的绝对路径。

```sh
linear recipe jj-commits --source > jj-commits.js
deno run --allow-run --allow-env jj-commits.js ENG-123
```

脚本先确认 Issue 存在，再通过 `jj log` 查询完整编号。`ENG-1` 不匹配 `ENG-10` 或 `OTHERENG-1`。推荐描述末尾为 `Linear-issue: Fixes ENG-123`；其他 JJ 参数和输出模板以 `jj help log` 为准。

编写提交描述可以先运行 `linear issue describe ENG-123`。CLI 中读取当前 Issue 的 Git/Jujutsu 上下文推断仍保留；本脚本要求显式传入完整编号。
