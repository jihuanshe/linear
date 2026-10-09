"""Use the production install task without replacing the developer's CLI."""

import os
import subprocess
from pathlib import Path

root = Path("outputs/contract-install").resolve()
root.mkdir(parents=True, exist_ok=True)
# Set this after mise has prepared the environment: mise's Deno backend also
# sets DENO_INSTALL_ROOT and overrides an assignment outside `mise exec`.
environment = {
    name: os.environ[name]
    for name in (
        "PATH",
        "HOME",
        "SystemRoot",
        "WINDIR",
        "TMPDIR",
        "TEMP",
        "TMP",
        "DENO_DIR",
    )
    if name in os.environ
}
environment["DENO_INSTALL_ROOT"] = str(root)
subprocess.run(["deno", "task", "install"], env=environment, check=True)
print(root / "bin" / ("linear.exe" if os.name == "nt" else "linear"))
