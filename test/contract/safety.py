"""Check the acceptance driver's boundaries without accessing a live workspace."""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import live
import run as runner
from gateway import LinearGateway
from harness import ProtocolServer, Reply, Scenario, equal, require
from offline import MUTATION, QUERY


def gateway_permissions(binary: Path) -> None:
    scenario = Scenario(binary)
    try:
        with ProtocolServer(
            [Reply(), Reply({"data": {"issueDelete": {"success": True}}})]
        ) as upstream:
            with LinearGateway(upstream=upstream.endpoint) as gateway:
                with gateway.command(may_write=True) as endpoint:
                    refused = scenario.run(
                        "api", MUTATION, "--unprotected", endpoint=endpoint
                    )
                    require(
                        refused.code != 0, "unverified gateway forwarded a mutation"
                    )
                upstream.count(0)
                gateway.enable_mutations()
                with (
                    gateway.command(may_write=False) as endpoint,
                    gateway.command(may_write=True) as writable,
                ):
                    refused = scenario.run(
                        "api", MUTATION, "--unprotected", endpoint=endpoint
                    )
                    require(refused.code != 0, "read-only command forwarded a mutation")
                    scenario.run("api", QUERY, endpoint=endpoint).document()
                    upstream.count(1)
                    scenario.run(
                        "api", MUTATION, "--unprotected", endpoint=writable
                    ).document()
                upstream.count(2)
                require(
                    all(not entry["forwarded"] for entry in gateway.requests[:2]),
                    "refused writes reached upstream",
                )
                expired = scenario.run(
                    "api", MUTATION, "--unprotected", endpoint=writable
                )
                require(
                    expired.code != 0, "expired command permission remained writable"
                )
                upstream.count(2)
    finally:
        scenario.close()


def live_deadlines(_binary: Path) -> None:
    # Deliberately slow executables exercise the live Scenario entry, using
    # only an offline credential and local protocol endpoint.
    scenario = Scenario(Path(sys.executable), key="offline-safety-key")
    try:
        try:
            scenario.run("-c", "import time; time.sleep(.15)", timeout=0.03)
        except AssertionError as error:
            require("exceeded" in str(error), "unexpected timeout failure")
        else:
            raise AssertionError("live read ignored its subprocess deadline")
        result = scenario.run(
            "-c", "import time; time.sleep(.08)", timeout=0.01, may_write=True
        )
        equal(result.code, 0)
        require(
            result.seconds >= 0.08, "live write was interrupted at its read deadline"
        )
        with (
            ProtocolServer([]) as upstream,
            LinearGateway(upstream=upstream.endpoint) as gateway,
        ):
            gateway.enable_mutations()
            scenario.live_scope = lambda may_write: gateway.command(may_write=may_write)
            source = f"""import json,os,time,urllib.error,urllib.request
request=urllib.request.Request(os.environ["LINEAR_GRAPHQL_ENDPOINT"],data=json.dumps({{"query":{MUTATION!r}}}).encode(),headers={{"Content-Type":"application/json"}},method="POST")
try:
    urllib.request.urlopen(request,timeout=.2).close()
except urllib.error.HTTPError:
    pass
time.sleep(2)
"""
            try:
                scenario.run("-c", source, timeout=0.5)
            except AssertionError as error:
                require("exceeded" in str(error), "unexpected bounded-read failure")
            else:
                raise AssertionError("defective live read ignored its deadline")
            equal(len(gateway.requests), 1)
            equal(gateway.requests[0]["forwarded"], False)
            upstream.count(0)
    finally:
        scenario.close()


def identity_gate(binary: Path) -> None:
    for cli_name, actual_name, actual_id in (
        ("Other", "Other", "workspace"),
        ("Kadoraba", "Other", "workspace"),
        ("Kadoraba", "Kadoraba", "wrong-workspace"),
        ("Kadoraba", "Kadoraba", "workspace"),
    ):
        accepted = cli_name == actual_name == "Kadoraba" and actual_id == "workspace"
        viewer = {
            "id": "viewer",
            "organization": {
                "id": "workspace",
                "name": cli_name,
                "urlKey": cli_name.lower(),
            },
        }
        actual = {
            "data": {
                "organization": {
                    "id": actual_id,
                    "name": actual_name,
                    "urlKey": actual_name.lower(),
                },
                "viewer": {"id": "viewer"},
            }
        }
        with (
            ProtocolServer(
                [
                    Reply({"data": {"viewer": viewer}}),
                    Reply({"data": {"issueDelete": {"success": True}}}),
                ]
            ) as upstream,
            ProtocolServer([Reply(actual)]) as oracle,
            LinearGateway(upstream=upstream.endpoint) as gateway,
        ):
            run = live.LiveRun(
                binary, "offline-contract-key", oracle_endpoint=oracle.endpoint
            )
            run.requests = gateway.requests
            run.scenario.live_scope = lambda may_write: gateway.command(
                may_write=may_write
            )
            try:
                try:
                    run.verify_identity(gateway)
                except AssertionError:
                    require(not accepted, "valid independent identity was refused")
                else:
                    require(accepted, "unverified identity enabled live writes")
                equal(run.workspace, actual["data"]["organization"] if accepted else {})
                result = run.scenario.run(
                    "api", MUTATION, "--unprotected", may_write=True
                )
                equal(result.code == 0, accepted)
                upstream.count(2 if accepted else 1)
                oracle.count(0 if cli_name == "Other" else 1)
            finally:
                run.scenario.close()


def unexpected_identity_write(binary: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="linear-safety-identity-") as temporary:
        candidate = Path(temporary) / "writes-during-whoami"
        candidate.write_text(f"""#!{sys.executable}
import os,subprocess,sys
if sys.argv[1:3] == ["auth", "whoami"]:
    subprocess.run([{str(binary)!r}, "api", {MUTATION!r}, "--unprotected"], input="", capture_output=True)
os.execv({str(binary)!r}, [{str(binary)!r}, *sys.argv[1:]])
""")
        candidate.chmod(0o700)
        organization = {"id": "workspace", "name": "Kadoraba", "urlKey": "kadoraba"}
        viewer = {"id": "viewer", "organization": organization}
        with (
            ProtocolServer([Reply({"data": {"viewer": viewer}})]) as upstream,
            ProtocolServer(
                [
                    Reply(
                        {
                            "data": {
                                "organization": organization,
                                "viewer": {"id": "viewer"},
                            }
                        }
                    )
                ]
            ) as oracle,
            LinearGateway(upstream=upstream.endpoint) as gateway,
        ):
            run = live.LiveRun(
                candidate, "offline-contract-key", oracle_endpoint=oracle.endpoint
            )
            run.requests = gateway.requests
            run.scenario.live_scope = lambda may_write: gateway.command(
                may_write=may_write
            )
            try:
                try:
                    run.verify_identity(gateway)
                except AssertionError as error:
                    require(
                        "gateway refused command traffic" in str(error),
                        "unexpected identity rejection",
                    )
                else:
                    raise AssertionError(
                        "identity command concealed a refused mutation"
                    )
                result = run.scenario.run(
                    "api", MUTATION, "--unprotected", may_write=True
                )
                require(result.code != 0, "failed identity step enabled writes")
                upstream.count(1)
                oracle.count(1)
                equal(len(run.resources), 0)
            finally:
                run.scenario.close()


def offline_failure_skips_live(binary: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="linear-safety-runner-") as temporary:
        root = Path(temporary)
        candidate = root / "failed-candidate"
        candidate.write_text("#!/bin/sh\nexit 1\n")
        candidate.chmod(0o700)
        report = root / "report.json"
        args = [
            "run.py",
            "--binary",
            str(candidate),
            "--report",
            str(report),
            "--filter",
            "^local.issue-identifier-from-git$",
            "--live",
        ]
        # Only the external live connector is isolated; runner.main and the
        # selected offline case execute normally. No fake business success.
        terminal = io.StringIO()
        with (
            patch.object(sys, "argv", args),
            patch.object(sys, "stdin", terminal),
            patch.object(terminal, "isatty", return_value=True),
            patch.object(
                live,
                "run_live",
                side_effect=AssertionError(
                    "live boundary entered after offline failure"
                ),
            ) as live_boundary,
        ):
            equal(runner.main(), 1)
            live_boundary.assert_not_called()
        evidence = json.loads(report.read_text())
        equal(evidence["summary"]["failed"], 1)
        equal(evidence["live"], None)
        equal(evidence["liveSkippedReason"], "offline-failures")
        # The converse must enter the connector. Its deliberate failure is a
        # boundary signal, not fabricated business acceptance.
        args[args.index("--binary") + 1] = str(binary)
        with (
            patch.object(sys, "argv", args),
            patch.object(sys, "stdin", terminal),
            patch.object(terminal, "isatty", return_value=True),
            patch.object(
                live,
                "run_live",
                return_value={
                    "passed": False,
                    "behaviorCommands": [],
                    "error": "offline connector boundary",
                },
            ) as live_boundary,
        ):
            equal(runner.main(), 1)
            live_boundary.assert_called_once()
        evidence = json.loads(report.read_text())
        equal(evidence["summary"]["failed"], 0)
        equal(evidence["liveSkippedReason"], None)
        equal(evidence["live"]["error"], "offline connector boundary")


def late_creation_receipt(binary: Path) -> None:
    # The external executable fixture times out after dispatch; the production
    # live driver must retain the later receipt and use the real CLI to clean it.
    label_id = "12345678-1234-1234-1234-123456789abc"
    prefix = "cli-contract-late-receipt"
    label = {"id": label_id, "name": prefix, "color": "#112233", "team": None}
    with tempfile.TemporaryDirectory(prefix="linear-safety-late-") as temporary:
        root = Path(temporary)
        candidate = root / "early-create-timeout"
        candidate.write_text(f"""#!{sys.executable}
import json,os,sys,urllib.request
if sys.argv[1:3] == ["label", "create"]:
    body={{"query":"mutation {{ issueLabelCreate(input: {{ name: \\\"{prefix}\\\" }}) {{ success issueLabel {{ id name }} }} }}"}}
    request=urllib.request.Request(os.environ["LINEAR_GRAPHQL_ENDPOINT"],data=json.dumps(body).encode(),headers={{"Content-Type":"application/json","Authorization":os.environ["LINEAR_API_KEY"]}},method="POST")
    try:
        urllib.request.urlopen(request,timeout=.025).close()
    except TimeoutError:
        print(json.dumps({{"ok":False,"effect":"unknown"}}))
        sys.exit(1)
    sys.exit(2)
os.execv({str(binary)!r}, [{str(binary)!r}, *sys.argv[1:]])
""")
        candidate.chmod(0o700)
        progress = root / "live-progress.json"
        with (
            ProtocolServer(
                [
                    Reply(
                        {
                            "data": {
                                "issueLabelCreate": {
                                    "success": True,
                                    "issueLabel": label,
                                }
                            }
                        },
                        delay=0.2,
                    ),
                    Reply({"data": {"issueLabel": label}}),
                    Reply({"data": {"issueLabelDelete": {"success": True}}}),
                ]
            ) as upstream,
            ProtocolServer(
                [
                    Reply({"data": {"issueLabel": label}}),
                    Reply({"data": {"issueLabel": None}}),
                ]
            ) as oracle,
        ):
            run_type = live.LiveRun
            gateway = LinearGateway(upstream=upstream.endpoint)

            def local_run(target: Path, key: str, journal: Path | None) -> live.LiveRun:
                run = run_type(target, key, journal, oracle_endpoint=oracle.endpoint)
                run.prefix = prefix
                return run

            def workflow(run: live.LiveRun, gateway: LinearGateway) -> None:
                # Identity is tested separately. Only this disposable local
                # connector is opened to exercise the late-receipt boundary.
                gateway.enable_mutations()
                run.step(
                    "late-create-receipt",
                    ["label create"],
                    lambda: run.create("label", "issueLabel", prefix, name=prefix),
                )

            with (
                patch.object(run_type, "workflow", workflow),
                patch.object(live, "LiveRun", side_effect=local_run),
                patch.object(live, "LinearGateway", return_value=gateway),
                patch.object(
                    live,
                    "os",
                    SimpleNamespace(
                        environ={"LINEAR_KADORABA_API_KEY": "offline-contract-key"}
                    ),
                ),
            ):
                report = live.run_live(candidate, progress=progress)
            equal(report["passed"], False)
            equal(report["steps"][0]["passed"], False)
            equal(json.loads(report["processes"][0]["stdout"])["effect"], "unknown")
            equal([resource["id"] for resource in report["resources"]], [label_id])
            require(
                not any(
                    intent["outcome"] == "unresolved-creation-receipt"
                    for intent in report["intents"]
                ),
                "known late receipt remained unresolved",
            )
            equal(len(report["cleanup"]), 1)
            equal(report["cleanup"][0]["passed"], True)
            equal(report["cleanup"][0]["state"], "absent")
            upstream.count(3)
            oracle.count(2)
            equal(upstream.requests[2]["body"]["variables"]["id"], label_id)
            saved = json.loads(progress.read_text())
            equal(saved["resources"], report["resources"])
            equal(saved["cleanup"], report["cleanup"])


def resume_missing_tools(_binary: Path) -> None:
    for missing in ("python", "uv"):
        with tempfile.TemporaryDirectory(prefix="linear-safety-orb-") as temporary:
            home = Path(temporary)
            repo = home / "workspace/repo"
            (repo / ".agents").mkdir(parents=True)
            shutil.copyfile(
                Path(__file__).parents[2] / ".agents/resume", repo / ".agents/resume"
            )
            tools = home / "tools"
            tools.mkdir()
            sha256sum = tools / "sha256sum"
            sha256sum.write_text(
                f"#!{sys.executable}\nimport hashlib,sys\nprint(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())\n"
            )
            sha256sum.chmod(0o700)
            available = tools / "available"
            available.write_text("#!/bin/sh\nexit 0\n")
            available.chmod(0o700)
            mise = tools / "mise"
            mise.write_text(
                f'#!/bin/sh\nif [ "$3" = "which" ]; then\n  [ "$4" != "{missing}" ] || exit 1\n  printf "%s\\n" "{available}"\nfi\n'
            )
            mise.chmod(0o700)
            env = {"HOME": str(home), "PATH": f"{tools}:{os.defpath}", "AMP_ORB": "1"}
            result = subprocess.run(
                ["bash", str(repo / ".agents/resume")],
                env=env,
                capture_output=True,
                text=True,
                timeout=5,
            )
            require(result.returncode != 0, f"resume accepted missing {missing}")
            require(
                f"{missing} is missing; run .agents/setup" in result.stderr,
                f"resume omitted the repair hint: {result.stderr!r}",
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    results = []
    for check in (
        gateway_permissions,
        identity_gate,
        unexpected_identity_write,
        live_deadlines,
        offline_failure_skips_live,
        late_creation_receipt,
        resume_missing_tools,
    ):
        error = None
        try:
            check(binary)
        except Exception as exception:
            error = f"{type(exception).__name__}: {exception}"
        results.append(
            {"name": check.__name__, "passed": error is None, "error": error}
        )
        print(
            f"{'PASS' if error is None else 'FAIL'} safety.{check.__name__}: {error or ''}",
            flush=True,
        )
    report = {"passed": all(result["passed"] for result in results), "checks": results}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    return int(not report["passed"])


if __name__ == "__main__":
    raise SystemExit(main())
