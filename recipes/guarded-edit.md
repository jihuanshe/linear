# 讨论后提交 Issue 正文

在阅读旧正文之后才决定如何修改时使用。脚本把保存初读和提交分为两个动作，避免提交时用新读取替代讨论依据。比较与写入由 `linear issue update` 完成。

执行需要 Deno 和当前 `linear`；`LINEAR_BIN` 可以固定 CLI 的绝对路径。读取说明和源码本身无需 Deno 或网络。

```sh
linear recipe guarded-edit --source > guarded-edit.js
deno run --allow-run --allow-env --allow-read --allow-write guarded-edit.js \
  prepare ENG-123 issue-edit
# 阅读 issue-edit/original.json，讨论并编辑 issue-edit/desired.md。
deno run --allow-run --allow-env --allow-read --allow-write guarded-edit.js \
  submit issue-edit >result.json
jq '{ok, effect, fields, error}' result.json
```

prepare 创建新的本地目录，保存原始 JSON 与正文草稿，不修改 Linear；目录已存在时拒绝继续。submit 按保存的 UUID 提交正文，不重新保存依据；执行前需要当前任务的写入授权。

冲突时保留原始依据和草稿，读取当前对象后重新决定如何保留并发修改。`effect: unknown` 表示效果未知，先对账，不自动重试。需要组合多项写入并恢复时读取 `linear guide issue-delivery`；本脚本不维护执行账本。

Python 可以消费同一文件与进程合同，不需要复写比较算法。已有上述准备目录时：

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
raise SystemExit(result.returncode)
```
