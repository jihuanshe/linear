"""Prove acceptance rejects specific defects in an executable's behavior."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from harness import Scenario, require
from offline import cases

DEFECTS = [
    ("json-pollution", "api.stdin-and-variable-roundtrip", "stdout is not one JSON"),
    ("false-success", "validation.mutation-guard", "exited successfully"),
    ("lost-partial-data", "transport.preserve-partial-data", "keep-me"),
    (
        "duplicate-mutation",
        "transport.mutation-never-retried-429",
        "expected 1, received 2",
    ),
    ("lost-page", "pagination.all-pages-and-api-shape", "three"),
    ("lost-variables", "api.stdin-and-variable-roundtrip", "nested"),
    ("unknown-as-none", "transport.mutation-unknown-disconnect", "expected 'unknown'"),
    ("unexpected-get", "validation.mutation-guard", "expected 0, received 1"),
    (
        "bypass-delivery-lock",
        "delivery.external-checkpoint-lock",
        "did not wait for the held checkpoint lock",
    ),
]


def run(binary: Path) -> dict:
    require(
        os.name != "nt",
        "the defect wrapper currently requires a POSIX executable script",
    )
    by_name = {case.name: case for case in cases()}
    results: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="linear-defects-") as directory:
        for defect, name, expected in DEFECTS:
            wrapper = Path(directory) / defect
            wrapper.write_text(
                f"""#!{sys.executable}
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

args = sys.argv[1:]
stdin = sys.stdin.read()
if {defect!r} == "unexpected-get":
    try:
        urllib.request.urlopen(os.environ["LINEAR_GRAPHQL_ENDPOINT"]).close()
    except urllib.error.HTTPError:
        pass
if {defect!r} == "bypass-delivery-lock":
    index = args.index("--file") + 1
    original = Path(args[index])
    unlocked = original.with_name("unlocked-manifest.json")
    shutil.copyfile(original, unlocked)
    shutil.copyfile(str(original) + ".checkpoint.json", str(unlocked) + ".checkpoint.json")
    args[index] = str(unlocked)
if {defect!r} == "lost-variables":
    for option in ("--variables-file", "--variables-json"):
        if option in args:
            index = args.index(option)
            args[index:index + 2] = ["--variables-json", "{{}}"]
result = subprocess.run([{str(binary)!r}, *args], input=stdin, capture_output=True, text=True)
if {defect!r} == "duplicate-mutation":
    subprocess.run([{str(binary)!r}, *args], input=stdin, capture_output=True, text=True)
stdout = result.stdout
if {defect!r} == "json-pollution":
    stdout = "progress\\n" + stdout
if {defect!r} in ("lost-partial-data", "lost-page", "unknown-as-none"):
    doc = json.loads(stdout)
    if {defect!r} == "lost-partial-data":
        doc.pop("data", None)
    if {defect!r} == "lost-page":
        doc["data"]["picked"]["nodes"] = doc["data"]["picked"]["nodes"][:1]
    if {defect!r} == "unknown-as-none":
        doc["effect"] = "none"
    stdout = json.dumps(doc)
sys.stdout.write(stdout)
sys.stderr.write(result.stderr)
sys.exit(0 if {defect!r} == "false-success" else result.returncode)
""",
                encoding="utf-8",
            )
            wrapper.chmod(0o700)
            scenario = Scenario(wrapper)
            rejection = None
            try:
                by_name[name].check(scenario)
            except AssertionError as error:
                rejection = str(error)
            finally:
                scenario.close()
            detected = rejection is not None and expected in rejection
            results.append(
                {
                    "defect": defect,
                    "case": name,
                    "detected": detected,
                    "rejection": rejection,
                }
            )
            print(f"{'PASS' if detected else 'FAIL'} detect.{defect}", flush=True)
    return {"passed": all(result["detected"] for result in results), "defects": results}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = run(args.binary.resolve(strict=True))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    return int(not report["passed"])


if __name__ == "__main__":
    raise SystemExit(main())
