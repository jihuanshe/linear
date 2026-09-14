# 在脚本中分开准备与提交正文

需要把 Issue 正文编辑接入自己的脚本时使用本例。`prepare` 导出原始依据和草稿，`submit` 使用保存的 UUID 与原始依据提交，比较和写入均由 CLI 完成。日常手动编辑直接用 `issue export` 和 `issue update`，完整例子见 `linear guide automation`。

执行需要 Deno 和当前 `linear`；`LINEAR_BIN` 可以固定 CLI 的绝对路径。

```sh
linear recipe guarded-edit --source > guarded-edit.js
deno run --allow-run --allow-env --allow-read --allow-write guarded-edit.js \
  prepare ENG-123 issue-edit
# prepare 成功后，阅读 issue-edit/original.json 并编辑 issue-edit/desired.md。
deno run --allow-run --allow-env --allow-read --allow-write guarded-edit.js \
  submit issue-edit >result.json
jq '{ok, effect, fields, error}' result.json
```

`prepare ISSUE NEW_DIRECTORY` 不修改 Linear，目录已存在时拒绝继续。`submit DIRECTORY` 只更新该 Issue 的正文，不保存新依据；执行前核对本次要提交的草稿。

准备失败后不要继续提交。冲突时保留原始依据和草稿，结合当前正文重新决定修改。`effect: unknown` 先对账，`effect: applied` 不重发已确认写入；输出与恢复规则见 `linear guide automation`。脚本不维护执行账本，需要记录多项写入进度时用 `linear guide issue-delivery`。
