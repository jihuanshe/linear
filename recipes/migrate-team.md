# 冻结团队迁移范围，生成交付清单

需要把原团队的完整 Issue 集合迁移到另一个团队时使用。脚本只读取远端，在新目录保存原始依据和 `schemaVersion: 2` 交付清单；不执行迁移，不删除团队。执行需要 Deno 和当前 `linear`；`LINEAR_BIN` 可以固定 CLI 的绝对路径。

```sh
linear recipe migrate-team --source > migrate-team.js
deno run --allow-run --allow-env --allow-read --allow-write migrate-team.js \
  freeze OLD NEW migration
# 审阅 migration/manifest.json 和每个 *.base.json。
linear issue plan --file migration/manifest.json --json >migration/plan.json
# 取得本次迁移授权后，将 acme 换成 manifest.json 顶层 workspace 字段的工作区短名。
linear issue apply --file migration/manifest.json --confirm-workspace acme --json \
  >migration/apply.json 2>migration/apply.log
```

`freeze <sourceKey> <targetKey> <directory>` 接受原团队和目标团队的可读 key，以及尚不存在的目标目录；上例分别是 `OLD`、`NEW` 和 `migration`。脚本按团队 UUID 完整分页读取 Issue，再逐条用 UUID 保存 `{organization,issue}` 原始读取。清单每项使用 `operation: "update"`、`identifier: Issue UUID`、`set.team: 目标团队 UUID` 和相对路径 `baseFile`。清单保存工作区短名；原始依据保留工作区 UUID、原团队 UUID 和原编号。迁移后的编号从 apply 输出的 `.data.items[].receipt` 或执行账本的 Issue 回执取得，以 UUID 与原始依据对应，不再按旧编号查找。

目录必须不存在。重复 UUID、未完成的分页、读取失败或冻结期间工作区／团队归属改变都会拒绝完成，不生成 `manifest.json`；已保存的原始依据保留。空团队报告「No work」，不生成空的可执行清单。多页与多对象读取不是服务端原子快照，冻结后新建的 Issue 不会自动加入范围。

枚举包含归档对象；任何原始依据表明 Issue 已归档或在回收站时，整个冻结失败。脚本不自动取消归档、恢复或重新归档。先单独决定生命周期；确需恢复时，通过 Linear UI 或当前任务授权的 API 处理，再在新目录冻结范围。API 的字段与调用边界见 `linear schema`、`linear guide graphql`。

`plan` 和 `apply` 使用相同原始依据与专用 Issue 更新校验；冻结后的并发归档仍由写入前读取拒绝。`apply` 默认第一次失败就停止，前面已成功的项保留，不自动回滚。只有用户明确选择继续时才加 `--continue-on-failure`；该选项不能越过 `unknown`。这不是跨 Issue 事务。

Linear 迁移父 Issue 时可能联动其子 Issue；`plan` 不模拟这类上游副作用，审阅范围时需同时检查父子关系。跨团队会使用目标团队的 Workflow State UUID；需指定状态时使用目标团队的 UUID、名称或类型，不能用 `expectFields: ["state"]` 表达「保留同类状态」。若联动导致原值断言冲突，保留原始依据和账本，按 UUID 对账后修订仍需执行的目标，不覆盖原始依据来绕过冲突。

执行进度只由 `manifest.json.checkpoint.json` 记录。已确认成功的项在续跑时跳过，已知无效果的失败可在处理原因后续跑；未知结果必须先按 UUID 对账，不能直接重试。保留清单、依据、账本与每次原始输出，不覆盖旧结果文件；完整恢复步骤见 `linear guide issue-delivery`。

**旧迁移目录不转换、不重放。** 旧 `scope.json`、`receipts.jsonl` 和原始 stdout／stderr 必须原样保留。本脚本不再提供 `move`，也不生成新的 `receipts.jsonl`。先由操作人按稳定 UUID 核对旧回执和实际效果；任何 `unknown` 未查清前，不把它加入新执行清单。对账后仅为明确的剩余工作另建 `schemaVersion: 2` 交付清单和依据文件，不直接把旧 scope 全量转换，也不删除旧账本绕过恢复边界。

迁移完成后重新读取原团队，回执不能证明团队为空。团队删除是另一个必须取得授权的动作，归档和回收站对象同样计入空团队检查；用 `linear team delete OLD --dry-run --json` 检查，不为通过检查而擅自恢复或删除 Issue。
