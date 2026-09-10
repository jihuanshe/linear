# 固定范围迁移 Issue 团队

仅迁移未归档、未删除的 Issue，并保留原编号、新编号和每项结果时使用。脚本先冻结团队内的完整范围，再执行一次迁移；删除团队是另一个明确动作。

执行需要 Deno 和当前 `linear`；`LINEAR_BIN` 可以固定 CLI 的绝对路径。freeze 只读取远端并创建本地材料；move 会修改范围内的 Issue，需要当前任务的写入授权。

```sh
linear recipe migrate-team --source > migrate-team.js
deno run --allow-run --allow-env --allow-read --allow-write migrate-team.js \
  freeze OLD NEW migration
# 审阅 migration/scope.json 中的 UUID、原编号、工作区、目标团队与原始依据。
deno run --allow-run --allow-env --allow-read --allow-write migrate-team.js \
  move migration
```

freeze 仍完整枚举包含归档 Issue 的集合，逐条读取稳定 UUID 的原始依据。遇到归档或回收站中的 Issue 时明确拒绝，不生成可执行的 `scope.json`；先前保存的依据保留。归档与删除状态需要独立的生命周期决定，脚本不会自动取消归档、恢复或重新归档。多页与多对象读取不是服务端原子快照；冻结期间发现对象离开原团队也会拒绝完成。

CLI 没有专用 restore 命令。如果用户明确选择恢复，先通过 Linear UI 或经当前任务授权的 API 操作处理，再读回生命周期状态并在新目录冻结范围。`issueUnarchive(id)` 可以恢复回收站中的 Issue；调用前通过 `linear schema` 核对当前字段，原生 mutation 的授权与调用边界见 `linear guide graphql`。恢复不是删除团队的默认步骤，也不能为了满足空团队条件擅自扩大迁移或删除范围。

move 只处理冻结集合，先校验所有保存依据和团队身份；保存依据中存在归档或回收站中的 Issue 时，在创建 `receipts.jsonl` 和首个更新之前拒绝。校验通过后按 UUID 逐项迁移。原始 stdout、stderr 和 `receipts.jsonl` 保存在目录中，包含原编号、新编号及效果。第一次失败就停止；已成功的迁移保留，未知结果先按 UUID 对账，再明确选择后续对象。

冻结后的并发归档仍由每次 `issue update` 的最终读取拒绝，此时前面的 Issue 可能已经迁移。保存依据的预检不提供跨 Issue 事务保证。

创建 `receipts.jsonl` 后，同一目录不允许再次执行 move，不能靠删除账本或结果文件重放。保留原目录，按稳定 UUID 对账既有回执和远端效果，再明确选择剩余范围；需要继续迁移时，在新目录冻结该范围。脚本不会刷新依据、自动恢复、回滚或删除团队。迁移结束后必须重新读取原团队，成功回执本身不能证明团队为空。

确实需要删除且已取得删除授权时，原团队必须真正为空，归档和回收站中的 Issue 都计入数量。查询结果不能代替删除命令的空团队检查；仍有这些对象时先停下，单独决定生命周期：

```sh
linear issue query --team OLD --include-archived --limit 0 --json
linear team delete OLD --dry-run --json
# 确认仍为空后执行删除；命令还会再次检查。
linear team delete OLD --force --json
```
