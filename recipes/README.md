# 可组合工作流

这些普通脚本使用已安装的 CLI、Git、Jujutsu 或 GitHub CLI；不导入 `src/`，不包含 recipe runner。使用与 CLI 同版本的源码目录，或复制脚本到自己的工作目录再修改。设置 `LINEAR_BIN=/absolute/path/to/linear` 可固定可执行文件。写脚本仅在明确运行对应步骤时写入。

## 原始读取、讨论和受保护更新

以下 JS 示例把初读和提交分为两步；准备目录必须不存在，basis 文件使用独占创建，submit 不重新保存依据：

```sh
deno run --allow-run --allow-env --allow-read --allow-write recipes/guarded-edit.js \
  prepare ENG-123 issue-edit
# 阅读 issue-edit/original.json，讨论并编辑 issue-edit/desired.md。
deno run --allow-run --allow-env --allow-read --allow-write recipes/guarded-edit.js \
  submit issue-edit >result.json
jq '{ok, effect, fields, error}' result.json
```

脚本按保存的 UUID 调用 `issue update --base-file --description-file --json`。冲突时保留原始依据和 desired，读取当前对象后重新决定；unknown 先对账，不自动重试。需要批量执行与自动续跑时使用 [manifest v2 与 apply](../docs/guides/issue-delivery.md) 的唯一账本。

Python 只需使用同一文件和进程合同，不实现另一套比较或恢复算法。已有上述文件时：

```python
import json
import os
import subprocess
import sys
from pathlib import Path

folder = Path("issue-edit")
original = json.loads((folder / "original.json").read_text())
result = subprocess.run(
    [os.environ.get("LINEAR_BIN", "linear"), "issue", "update", original["issue"]["id"],
     "--base-file", str(folder / "original.json"),
     "--description-file", str(folder / "desired.md"), "--json"],
    text=True, capture_output=True,
)
print(result.stdout, end="")
sys.stderr.write(result.stderr)
if result.returncode:
    raise SystemExit(result.returncode)
```

## 选择 Issue 和建立工作上下文

```sh
linear issue mine
linear issue pick
linear issue view ENG-123 --json > original.json
```

`issue pick` 只把选择结果写 stdout，提示在 stderr；VCS 和状态写入由下列 recipe 显式执行。`team key` 输出配置的可读 key；真实 UUID 从 `team list --json` 的 `nodes[].id` 读取。

```sh
deno run --allow-run --allow-env --allow-read --allow-write recipes/start-work.js \
  git ENG-123 feature/eng-123 work-base.json 'In Progress' main
# Jujutsu：context 参数是描述，而不是分支名。
deno run --allow-run --allow-env --allow-read --allow-write recipes/start-work.js \
  jj ENG-123 'Implement login' jj-base.json 'In Progress' @
```

脚本先读取并保存原始依据，再执行原生 `git switch -c` 或 `jj new -m`，最后用同一依据调用受保护的 `issue update --state`。依据文件必须不存在，避免重新运行时静默刷新依据或重复创建上下文。若本地创建成功而状态更新失败，保留已有分支或 change，只处理结果并单独调用 `issue update`。这不是自动恢复入口。

创建新任务后同样显式取回 ID；`issue create` 不再承担 VCS 操作、开始工作提示或关联的 assignee 联动。

## GitHub PR 和 autolink

正文仍由调用者准备，`gh` 拥有 PR 参数与返回结果：

```sh
linear issue view ENG-123 --json > issue.json
# 编写 pr-body.md，包含相关 Issue URL 与本次改动。
sh recipes/create-pr.sh ENG-123 owner/repo pr-body.md --draft --base main
sh recipes/github-autolink.sh owner/repo ENG workspace-url-key
```

两步均不会自动重试。GitHub 返回不确定结果时，先通过原生 `gh` 查询后再决定下一步。

## Jujutsu 提交

```sh
linear issue describe ENG-123 > change-description.txt
# 原生 jj 参数仍由 jj help describe 说明。
deno run --allow-run --allow-env recipes/jj-commits.js ENG-123
```

匹配 `Linear-issue:` trailer 中的完整编号；例如 `ENG-1` 不匹配 `ENG-10` 或 `OTHERENG-1`。推荐 trailer：`Linear-issue: Fixes ENG-123`。当前 Issue 的只读 Git/JJ 推断仍留在核心 CLI。

## 创建项目后加入 Initiative

```sh
linear project create --name 'Launch' --team ENG --json > created-project.json
jq -e '.ok and .effect == "applied"' created-project.json
project_id=$(jq -er '.data.project.id' created-project.json)
linear initiative add-project INITIATIVE_UUID "$project_id" --json > initiative-link.json
```

第一步结果文件就是创建回执。第二步失败时使用已保存 ID 处理关联；不要重新创建项目。原生增量关联支持按返回效果对账。

## 团队迁移与删除

```sh
deno run --allow-run --allow-env --allow-read --allow-write recipes/migrate-team.js \
  freeze OLD NEW migration-2026-09-10
# 审阅 scope.json 中固定的 UUID、原编号、workspace、目标团队和各 base 文件。
deno run --allow-run --allow-env --allow-read --allow-write recipes/migrate-team.js \
  move migration-2026-09-10
linear issue query --team OLD --include-archived --limit 0 --json
linear team delete OLD --dry-run --json
# 确认仍为空后，才显式删除。
linear team delete OLD --force --json
```

freeze 完整读取包含归档的 Issue 集合，并在每个稳定 UUID 上保存原始依据；多页与多对象读取不是服务端快照。move 只处理冻结集合，按稳定 ID 逐项迁移，保存每项原始输出与 `receipts.jsonl` 的编号映射。首个失败停止，已有成功保留；`unknown` 或缺少完成回执时，先按 UUID 对账，再由操作者明确选择后续对象。

该目录只允许一次 move 尝试。脚本不自动重放、不刷新 base、不自动删除团队；重名 key、workspace 或团队 UUID 变化会拒绝。成功回执不能单独证明团队为空，删除命令会重新检查。

## 只读治理

```sh
deno run --allow-run --allow-env recipes/doctor.js self --json > doctor.json
```

范围、九条规则、history、归档与阈值说明见 [doctor Guide](../docs/guides/doctor.md)。severity 是可修改的组织约定，候选报告不等于修复计划。
