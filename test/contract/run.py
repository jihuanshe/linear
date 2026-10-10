"""Run the same acceptance cases against any CLI executable."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

sys.dont_write_bytecode = True

from harness import (  # noqa: E402 - disable import caches before local imports
    Case,
    Scenario,
)
from offline import cases  # noqa: E402


def execute(binary: Path, case: Case) -> dict:
    scenario = Scenario(binary)
    start = time.monotonic()
    error = None
    try:
        case.check(scenario)
    except Exception as exception:
        error = f"{type(exception).__name__}: {exception}"
    finally:
        record = {
            "name": case.name,
            "commands": case.commands,
            "boundary": case.boundary,
            "passed": error is None,
            "error": error,
            "seconds": time.monotonic() - start,
            "processes": [asdict(result) for result in scenario.results],
            "requests": scenario.wire,
            "discoveredCommands": scenario.discovered_commands,
            "discoveryGaps": scenario.discovery_gaps,
        }
        scenario.close()
    print(
        f"{'PASS' if error is None else 'FAIL'} {case.name} ({record['seconds']:.3f}s)",
        flush=True,
    )
    if error:
        print(f"  {error}", flush=True)
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--binary",
        required=True,
        type=Path,
        help="Executable under test; no source import",
    )
    parser.add_argument(
        "--report", required=True, type=Path, help="Write structured evidence here"
    )
    parser.add_argument("--jobs", type=int, default=min(8, os.cpu_count() or 1))
    parser.add_argument(
        "--slow",
        action="store_true",
        help="Include real wall-clock request/body deadline cases (~60s)",
    )
    parser.add_argument(
        "--filter", default="", help="Regex selecting offline case names"
    )
    parser.add_argument(
        "--live", action="store_true", help="Authorized disposable Kadoraba workflows"
    )
    args = parser.parse_args()
    if (
        args.live
        and "LINEAR_KADORABA_API_KEY" not in os.environ
        and not sys.stdin.isatty()
    ):
        parser.error(
            "live acceptance needs LINEAR_KADORABA_API_KEY or an interactive hidden prompt"
        )
    binary = args.binary.expanduser().resolve(strict=True)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error("--binary must name an executable file")
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    try:
        selection = re.compile(args.filter)
    except re.error as error:
        parser.error(str(error))
    selected = [
        case for case in cases(include_slow=args.slow) if selection.search(case.name)
    ]
    if not selected:
        parser.error("--filter selected zero cases")
    with binary.open("rb") as executable:
        binary_hash = hashlib.file_digest(executable, "sha256").hexdigest()
    report: dict = {
        "schemaVersion": 1,
        "binary": str(binary),
        "binarySha256": binary_hash,
        "python": sys.version.split()[0],
        "jobs": args.jobs,
        "liveRequested": args.live,
        "deadlineCasesRequested": args.slow,
        "cases": [],
        "live": None,
        "liveSkippedReason": None,
        "limitations": [
            "Offline server is a scripted HTTP fault injector, not a Linear domain implementation.",
            "No keyring, browser/editor interaction, uploads, download authorization, or all flag combinations.",
            "Existing implementation tests and platform release checks remain required.",
        ],
    }
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        report["cases"] = list(pool.map(lambda case: execute(binary, case), selected))
    if args.live:
        if any(not case["passed"] for case in report["cases"]):
            report["liveSkippedReason"] = "offline-failures"
            print("Skipping live acceptance: offline cases failed", flush=True)
        else:
            from live import run_live

            report["live"] = run_live(
                binary, progress=args.report.with_suffix(".live-progress.json")
            )
    report["seconds"] = time.monotonic() - started
    report["summary"] = {
        "passed": sum(case["passed"] for case in report["cases"]),
        "failed": sum(not case["passed"] for case in report["cases"]),
        "commandPathsChecked": sorted(
            {command for case in report["cases"] for command in case["commands"]}
        ),
    }
    if report["live"] is not None:
        report["summary"]["livePassed"] = report["live"]["passed"]
    discovered = sorted(
        {command for case in report["cases"] for command in case["discoveredCommands"]}
    )
    live_commands = set(report["live"]["behaviorCommands"]) if report["live"] else set()
    offline_commands = {
        command
        for case in report["cases"]
        if case["passed"]
        and case["boundary"] not in ("offline-discovery", "offline-validation")
        for command in case["commands"]
    }
    report["coverage"] = {
        "discoveredLeafCommands": discovered,
        "groupsWithoutMachineDiscovery": sorted(
            {group for case in report["cases"] for group in case["discoveryGaps"]}
        ),
        "offlineProtocolCommands": sorted(
            {
                command
                for case in report["cases"]
                if case["passed"]
                and case["name"].startswith(("transport.", "pagination.", "api."))
                for command in case["commands"]
            }
        ),
        "offlineValidationCommands": sorted(
            {
                command
                for case in report["cases"]
                if case["passed"] and case["name"].startswith("validation.")
                for command in case["commands"]
            }
        ),
        "liveBusinessCommands": sorted(live_commands),
        "withoutPositiveBehaviorScenario": sorted(
            set(discovered) - live_commands - offline_commands
        ),
        "note": "Discovery, validation-only coverage and real business behavior are distinct; this is not source line coverage.",
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(
        f"{report['summary']['passed']}/{len(selected)} offline cases passed in {report['seconds']:.2f}s; {args.report}"
    )
    return int(
        bool(report["summary"]["failed"])
        or (report["live"] is not None and not report["live"]["passed"])
    )


if __name__ == "__main__":
    raise SystemExit(main())
