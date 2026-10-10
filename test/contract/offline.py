"""Public CLI contracts and actual HTTP faults, not a mocked Linear backend."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

from gateway import LinearGateway, operation_kind
from harness import (
    Case,
    ProtocolServer,
    Reply,
    Result,
    Scenario,
    connection,
    equal,
    require,
)

QUERY = "query Probe { viewer { id } }"
MUTATION = 'mutation Probe { issueDelete(id: "disposable-protocol-probe") { success } }'
PAGES = "query Pages($after: String) { picked: teams(first: 1, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }"
RATE = {"errors": [{"message": "Slow down", "extensions": {"code": "RATELIMITED"}}]}


def cases(*, include_slow: bool = False) -> list[Case]:
    result: list[Case] = []

    def add(
        name: str, commands: tuple[str, ...], check: Callable[[Scenario], None]
    ) -> None:
        boundary = {
            "navigation": "offline-discovery",
            "validation": "offline-validation",
            "packaging": "offline-packaging",
            "local": "offline-local",
        }.get(name.split(".")[0], "offline-protocol")
        result.append(Case(name, commands, check, boundary=boundary))

    def discovery(s: Scenario) -> None:
        version = s.run("version", "--json").document()
        equal(version["distribution"], "jihuanshe/linear")
        require(
            isinstance(version["version"], str) and version["version"],
            "missing build version",
        )
        root = s.run("usage", "--json").document()
        equal(root["command"]["path"], "linear")
        require(root["subcommands"], "empty command discovery")
        pending = [root]
        visited: set[str] = set()
        while pending:
            doc = pending.pop()
            path = doc["command"]["path"]
            require(path not in visited, "cycle in command discovery")
            visited.add(path)
            require(doc["subcommands"], f"missing domain navigation: {path}")
            for command in doc["subcommands"]:
                for field in ("path", "writes", "interactive", "outputModes"):
                    require(field in command, f"discovery missing {field}")
                public_path = command["path"].removeprefix("linear ")
                if command["hasSubcommands"]:
                    if "json" in command["outputModes"]:
                        pending.append(
                            s.run(*public_path.split(), "usage", "--json").document()
                        )
                    else:
                        s.discovery_gaps.append(public_path)
                else:
                    s.discovered_commands.append(public_path)

    add(
        "navigation.machine-discovery",
        ("version", "usage", "issue", "project", "document", "issue comment"),
        discovery,
    )

    def default_navigation(s: Scenario) -> None:
        for path in (
            (),
            ("auth",),
            ("team",),
            ("issue",),
            ("project",),
            ("document",),
            ("issue", "comment"),
        ):
            doc = s.run(*path, "-j").document()
            equal(doc["command"]["path"], " ".join(("linear", *path)))
            require(
                doc["subcommands"],
                "default domain JSON did not return command discovery",
            )

    add("navigation.default-domain-json", ("usage",), default_navigation)

    def packaged(s: Scenario) -> None:
        guides = s.run("guide", "--json").array()
        require(guides, "missing bundled guides")
        for guide in guides:
            doc = s.run("guide", guide["name"], "--json").document()
            equal(doc["name"], guide["name"])
            require(doc["body"].strip(), "empty embedded guide")
        recipes = s.run("recipe", "--json").array()
        require(recipes, "missing bundled recipes")
        for recipe in recipes:
            doc = s.run("recipe", recipe["name"], "--json").document()
            equal(doc["name"], recipe["name"])
            require(doc["body"].strip(), "empty recipe instructions")
            equal(s.run("recipe", recipe["name"], "--source").stdout, doc["source"])

    add("packaging.embedded-guides-and-recipes", ("guide", "recipe"), packaged)

    def help_and_errors(s: Scenario) -> None:
        for args in (("--help",), ("issue", "update", "--help")):
            r = s.run(*args)
            equal(r.code, 0)
            require("Usage:" in r.stdout, "help missing usage")
            equal(r.stderr, "")
        for args in (("--unknown-contract-option",), ("unknown-contract-command",)):
            r = s.run(*args)
            require(r.code != 0, "unknown input accepted")
            equal(r.stdout, "")
            require(r.stderr.strip(), "missing usage diagnostic")

    add("navigation.streams-and-exits", ("help", "issue update"), help_and_errors)

    def vcs_identifier(s: Scenario) -> None:
        subprocess.run(
            ["git", "init", "--quiet", "--initial-branch=eng-731-handoff"],
            cwd=s.cwd,
            env=s.env,
            check=True,
            capture_output=True,
        )
        r = s.run("issue", "identifier")
        equal(r.code, 0)
        equal(r.stdout, "ENG-731\n")
        equal(r.stderr, "")

    add("local.issue-identifier-from-git", ("issue identifier",), vcs_identifier)

    def chunked_request(s: Scenario) -> None:
        def check(server: ProtocolServer) -> None:
            with LinearGateway(upstream=server.endpoint, chunked=True) as gateway:
                doc = s.run("api", QUERY, endpoint=gateway.endpoint).document()
                equal(doc, {"data": {"viewer": {"id": "probe"}}})
            server.count(1)
            equal(server.requests[0]["transferEncoding"], "chunked")

        s.protocol([Reply()], check)

    add("transport.chunked-request-framing", ("api",), chunked_request)

    def guarded_batch(s: Scenario) -> None:
        def check(server: ProtocolServer) -> None:
            with LinearGateway(upstream=server.endpoint) as gateway:
                gateway.enable_mutations()
                doc = 'mutation Batch { a: issueDelete(id: "a") { success } b: issueDelete(id: "b") { success } }'
                with gateway.command(may_write=True) as endpoint:
                    failed = s.run("api", doc, "--unprotected", endpoint=endpoint)
                require(failed.code != 0, "live safety guard accepted a mutation batch")
                equal(len(gateway.requests), 1)
                equal(gateway.requests[0]["forwarded"], False)
                require(
                    gateway.requests[0].get("rejected"),
                    "missing safety refusal evidence",
                )
                require(
                    "one root mutation field" in gateway.requests[0]["rejected"],
                    "wrong batch refusal",
                )
            server.count(0)

        s.protocol([], check)

    add("transport.live-batch-guard-before-forwarding", ("api",), guarded_batch)

    if sys.platform == "linux":

        def locked_checkpoint(s: Scenario) -> None:
            import fcntl

            manifest = s.file(
                "locked/manifest.json",
                {
                    "schemaVersion": 2,
                    "workspace": "kadoraba",
                    "issues": [
                        {
                            "operation": "update",
                            "identifier": "00000000-0000-4000-8000-000000000001",
                            "comments": [{"body": "offline lock boundary"}],
                        }
                    ],
                },
            )
            s.file(
                "locked/manifest.json.checkpoint.json",
                "invalid ledger must only be read after locking",
            )
            lock_path = Path(str(manifest) + ".checkpoint.json.lock")
            lock_path.touch()
            organization = {
                "data": {
                    "organization": {
                        "id": "00000000-0000-4000-8000-000000000002",
                        "urlKey": "kadoraba",
                    }
                }
            }
            args = [
                "issue",
                "apply",
                "--file",
                str(manifest),
                "--confirm-workspace",
                "kadoraba",
                "--json",
            ]

            def check(server: ProtocolServer) -> None:
                with lock_path.open("r+b") as held:
                    fcntl.flock(held, fcntl.LOCK_EX)
                    process = subprocess.Popen(
                        [str(s.binary), *args],
                        cwd=s.cwd,
                        env=s.env
                        | {
                            "LINEAR_API_KEY": "offline-contract-key",
                            "LINEAR_GRAPHQL_ENDPOINT": server.endpoint,
                        },
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        start_new_session=True,
                    )
                    start = time.monotonic()
                    try:
                        observed = False
                        while time.monotonic() - start < 8 and process.poll() is None:
                            lines = Path("/proc/locks").read_text().splitlines()
                            pids = [
                                int(row.split()[5])
                                for row in lines
                                if " -> " in row
                                and row.split()[6].endswith(
                                    ":" + str(lock_path.stat().st_ino)
                                )
                            ]
                            for pid in pids:
                                try:
                                    observed |= os.getpgid(pid) == process.pid
                                except ProcessLookupError:
                                    pass
                            if observed:
                                break
                            time.sleep(0.05)
                        require(
                            observed,
                            "executor did not wait for the held checkpoint lock",
                        )
                        # The holder is another actor. The target reached this
                        # exact lock while the ledger remained unreadable.
                        require(process.poll() is None, "executor bypassed held lock")
                        equal(lock_path.stat().st_ino, os.fstat(held.fileno()).st_ino)
                        fcntl.flock(held, fcntl.LOCK_UN)
                        stdout, stderr = process.communicate(timeout=20)
                        result = Result(
                            args,
                            process.returncode,
                            stdout,
                            stderr,
                            time.monotonic() - start,
                        )
                        s.results.append(result)
                        result.write(effect="none", success=False)
                        require(lock_path.exists(), "fixed lock file was removed")
                        require(
                            all(
                                operation_kind(request["body"]) == "query"
                                for request in server.requests
                            ),
                            "mutation dispatched despite invalid locked ledger",
                        )
                    finally:
                        # Fault experiments are offline only; no real mutation
                        # is ever interrupted to manufacture an unknown result.
                        if process.poll() is None:
                            process.kill()
                            process.communicate()

            s.protocol([Reply(organization)], check)

        add("delivery.external-checkpoint-lock", ("issue apply",), locked_checkpoint)

    invalid = [
        ("mutation-guard", ["api", MUTATION]),
        ("query-unprotected", ["api", QUERY, "--unprotected"]),
        ("subscription", ["api", "subscription Probe { viewer { id } }"]),
        ("missing-document", ["api"]),
        ("empty-document", ["api", ""]),
        ("bad-graphql", ["api", "query {"]),
        (
            "ambiguous-operation",
            ["api", QUERY + ' mutation Other { issueDelete(id: "x") { success } }'],
        ),
        ("unknown-operation", ["api", QUERY, "--operation-name", "Other"]),
        (
            "duplicate-operation",
            ["api", QUERY + " " + QUERY, "--operation-name", "Probe"],
        ),
        ("invalid-variables", ["api", QUERY, "--variables-json", "["]),
        ("array-variables", ["api", QUERY, "--variables-json", "[]"]),
        ("null-variables", ["api", QUERY, "--variables-json", "null"]),
        ("scalar-variables", ["api", QUERY, "--variables-json", "5"]),
        ("empty-variables", ["api", QUERY, "--variables-json", ""]),
        (
            "mutual-variables",
            [
                "api",
                QUERY,
                "--variables-json",
                "{}",
                "--variables-file",
                "variables.json",
            ],
        ),
        ("mutation-pagination", ["api", MUTATION, "--unprotected", "--paginate"]),
        ("missing-after-definition", ["api", QUERY, "--paginate"]),
        ("required-after", ["api", PAGES.replace("String)", "String!)"), "--paginate"]),
        (
            "initial-cursor",
            ["api", PAGES, "--paginate", "--variables-json", '{"after":"existing"}'],
        ),
        ("recipe-conflict", ["recipe", "doctor", "--json", "--source"]),
        ("recipe-missing-name", ["recipe", "--source", "--json"]),
        ("unsupported-json-before-write", ["issue", "favorite", "ENG-1", "--json"]),
        (
            "issue-missing-basis",
            ["issue", "update", "ENG-1", "--title", "new", "--json"],
        ),
        (
            "issue-label-conflict",
            [
                "issue",
                "update",
                "ENG-1",
                "--label",
                "A",
                "--add-label",
                "B",
                "--unprotected",
                "--json",
            ],
        ),
        (
            "issue-priority-range",
            [
                "issue",
                "create",
                "--team",
                "ENG",
                "--title",
                "x",
                "--priority",
                "5",
                "--json",
            ],
        ),
        (
            "document-parent-conflict",
            [
                "document",
                "create",
                "--title",
                "x",
                "--project",
                "p",
                "--issue",
                "i",
                "--json",
            ],
        ),
    ]
    for name, args in invalid:

        def reject(s: Scenario, args: list[str] = args) -> None:
            s.file("variables.json", {})

            def check(server: ProtocolServer) -> None:
                r = s.run(*args, endpoint=server.endpoint)
                doc = r.write(effect="none", success=False)
                require(doc.get("error"), "missing machine error")
                server.count(0)

            s.protocol([], check)

        add(
            "validation." + name,
            (" ".join(args[:2]) if args[0] in ("issue", "document") else args[0],),
            reject,
        )

    def api_input(s: Scenario) -> None:
        variables = {
            "id": "中文/emoji 🧪",
            "empty": "",
            "boolean": False,
            "nested": {"list": [0, None]},
        }
        document = "query Probe($id: String!) { viewer { id } }"
        path = s.file("variables.json", variables)

        def check(server: ProtocolServer) -> None:
            equal(
                s.run(
                    "api",
                    "-",
                    "--variables-file",
                    str(path),
                    stdin=document,
                    endpoint=server.endpoint,
                ).document(),
                {"data": {"viewer": {"id": "probe"}}},
            )
            equal(
                s.run(
                    "api",
                    document,
                    "--variables-json",
                    json.dumps(variables),
                    endpoint=server.endpoint,
                ).document(),
                {"data": {"viewer": {"id": "probe"}}},
            )
            server.count(2)
            for request in server.requests:
                equal(request["body"].get("variables"), variables)
                equal(request["body"]["query"], document)

        s.protocol([Reply(), Reply()], check)

    add("api.stdin-and-variable-roundtrip", ("api",), api_input)

    for status in (429, 502, 503, 504):

        def retries(s: Scenario, status: int = status) -> None:
            def check(server: ProtocolServer) -> None:
                equal(
                    s.run("api", QUERY, endpoint=server.endpoint).document(),
                    {"data": {"viewer": {"id": "probe"}}},
                )
                server.count(3)
                for request in server.requests:
                    equal(request["body"]["query"], QUERY)
                    equal(request["body"].get("variables") or {}, {})
                    equal(operation_kind(request["body"]), "query")

            s.protocol(
                [
                    Reply("gateway overloaded", status),
                    Reply("gateway overloaded", status),
                    Reply(),
                ],
                check,
            )

        add(f"transport.query-retry-{status}", ("api",), retries)

    for status in (200, 400):

        def graphql_rate(s: Scenario, status: int = status) -> None:
            def check(server: ProtocolServer) -> None:
                s.run("api", QUERY, endpoint=server.endpoint).document()
                server.count(2)

            s.protocol([Reply(RATE, status), Reply()], check)

        add(f"transport.graphql-rate-limit-{status}", ("api",), graphql_rate)

    def exhausted(s: Scenario) -> None:
        def check(server: ProtocolServer) -> None:
            equal(
                s.run("api", QUERY, endpoint=server.endpoint).document(success=False),
                RATE,
            )
            server.count(3)

        s.protocol([Reply(RATE, 429)] * 3, check)

    add("transport.query-attempt-budget", ("api",), exhausted)

    preserved = [
        ("partial-data", {"data": {"viewer": {"id": "keep-me"}}, **RATE}, 503),
        (
            "unauthenticated",
            {
                "errors": [
                    {
                        "message": "Unauthenticated",
                        "extensions": {"code": "AUTHENTICATION_ERROR"},
                    }
                ]
            },
            429,
        ),
        (
            "validation-error",
            {
                "errors": [
                    {
                        "message": "Bad input",
                        "extensions": {"code": "GRAPHQL_VALIDATION_FAILED"},
                    }
                ]
            },
            502,
        ),
        (
            "mixed-errors",
            {"errors": RATE["errors"] + [{"message": "different failure"}]},
            504,
        ),
    ]
    for name, envelope, status in preserved:

        def unchanged(
            s: Scenario, envelope: dict = envelope, status: int = status
        ) -> None:
            def check(server: ProtocolServer) -> None:
                equal(
                    s.run("api", QUERY, endpoint=server.endpoint).document(
                        success=False
                    ),
                    envelope,
                )
                server.count(1)

            s.protocol([Reply(envelope, status)], check)

        add("transport.preserve-" + name, ("api",), unchanged)

    for status in (429, 503):

        def mutation_once(s: Scenario, status: int = status) -> None:
            def check(server: ProtocolServer) -> None:
                equal(
                    s.run(
                        "api", MUTATION, "--unprotected", endpoint=server.endpoint
                    ).document(success=False),
                    RATE,
                )
                server.count(1)

            s.protocol([Reply(RATE, status)], check)

        add(f"transport.mutation-never-retried-{status}", ("api",), mutation_once)

    for name, reply in (
        ("disconnect", Reply(disconnect=True)),
        ("invalid-json", Reply("<html>upstream failed</html>")),
        ("invalid-envelope", Reply({"unexpected": True})),
    ):

        def unknown(s: Scenario, reply: Reply = reply) -> None:
            def check(server: ProtocolServer) -> None:
                s.run("api", MUTATION, "--unprotected", endpoint=server.endpoint).write(
                    effect="unknown", success=False
                )
                server.count(1)

            s.protocol([reply], check)

        add("transport.mutation-unknown-" + name, ("api",), unknown)

    def operation_selection(s: Scenario) -> None:
        doc = QUERY + " " + MUTATION.replace("Probe", "Write")

        def check(server: ProtocolServer) -> None:
            s.run(
                "api", doc, "--operation-name", "Probe", endpoint=server.endpoint
            ).document()
            server.count(2)
            equal(server.requests[0]["body"]["operationName"], "Probe")

        s.protocol([Reply(RATE, 429), Reply()], check)

    add("transport.selected-query-can-retry", ("api",), operation_selection)

    def selected_mutation(s: Scenario) -> None:
        doc = QUERY + " " + MUTATION.replace("Probe", "Write")

        def check(server: ProtocolServer) -> None:
            s.run(
                "api",
                doc,
                "--operation-name",
                "Write",
                "--unprotected",
                endpoint=server.endpoint,
            ).document(success=False)
            server.count(1)
            equal(server.requests[0]["body"]["operationName"], "Write")

        s.protocol([Reply(RATE, 503)], check)

    add("transport.selected-mutation-cannot-retry", ("api",), selected_mutation)

    def document_formats(s: Scenario) -> None:
        documents = [
            ("{ viewer { id } }", "query"),
            (
                "fragment mutation on User { id } query Read { viewer { ...mutation } }",
                "query",
            ),
            ('mutation{ issueDelete(id: "x") { success } }', "mutation"),
            (
                'mutation\nmutation { issueDelete(id: "query { fake }") { success } }',
                "mutation",
            ),
            (
                'fragment Fields on User { id } mutation Write { issueDelete(id: "x") { success } }',
                "mutation",
            ),
            ("# mutation Fake { ignored }\nquery Read { viewer { id } }", "query"),
        ]

        def check(server: ProtocolServer) -> None:
            for document, kind in documents:
                args = ("--unprotected",) if kind == "mutation" else ()
                s.run("api", document, *args, endpoint=server.endpoint).document()
                equal(operation_kind(server.requests[-1]["body"]), kind)
            server.count(len(documents))

        s.protocol([Reply() for _ in documents], check)

    add("transport.operation-document-formats", ("api",), document_formats)

    def retry_after(s: Scenario) -> None:
        def check(server: ProtocolServer) -> None:
            s.run("api", QUERY, endpoint=server.endpoint).document()
            server.count(2)
            require(
                server.requests[1]["at"] - server.requests[0]["at"] >= 0.95,
                "Retry-After was shortened",
            )

        s.protocol([Reply(RATE, 429, {"Retry-After": "1"}), Reply()], check)

    add("transport.retry-after-respected", ("api",), retry_after)

    def long_retry_after(s: Scenario) -> None:
        def check(server: ProtocolServer) -> None:
            r = s.run("api", QUERY, endpoint=server.endpoint)
            equal(r.document(success=False), RATE)
            server.count(1)
            require(r.seconds < 10, "waited past the request budget")

        s.protocol([Reply(RATE, 429, {"Retry-After": "120"})], check)

    add("transport.retry-after-exceeds-budget", ("api",), long_retry_after)

    receipts = [
        ("missing-payload", {"data": {}}, "unknown"),
        ("null-payload", {"data": {"issueLabelCreate": None}}, "unknown"),
        ("unconfirmed", {"data": {"issueLabelCreate": {"success": False}}}, "unknown"),
        (
            "missing-identity",
            {
                "data": {
                    "issueLabelCreate": {
                        "success": True,
                        "issueLabel": {"name": "probe"},
                    }
                }
            },
            "applied",
        ),
        (
            "null-identity",
            {"data": {"issueLabelCreate": {"success": True, "issueLabel": None}}},
            "applied",
        ),
        (
            "partial-confirmation",
            {
                "data": {
                    "issueLabelCreate": {
                        "success": True,
                        "issueLabel": {"id": "00000000-0000-4000-8000-000000000001"},
                    }
                },
                "errors": [
                    {
                        "message": "receipt field unavailable",
                        "path": ["issueLabelCreate", "issueLabel", "name"],
                    }
                ],
            },
            "applied",
        ),
    ]
    for name, envelope, effect in receipts:

        def receipt(
            s: Scenario, envelope: dict = envelope, effect: str = effect
        ) -> None:
            def check(server: ProtocolServer) -> None:
                doc = s.run(
                    "label",
                    "create",
                    "--name",
                    "probe",
                    "--color",
                    "#5E6AD2",
                    "--json",
                    endpoint=server.endpoint,
                ).write(effect=effect, success=False)
                require(doc.get("error"), "missing receipt diagnostic")
                server.count(1)
                equal(operation_kind(server.requests[0]["body"]), "mutation")

            s.protocol([Reply(envelope)], check)

        add("receipts." + name, ("label create",), receipt)

    if include_slow:
        for kind, document, effect in (
            ("query", QUERY, "none"),
            ("mutation", MUTATION, "unknown"),
        ):

            def body_deadline(
                s: Scenario,
                document: str = document,
                effect: str = effect,
                kind: str = kind,
            ) -> None:
                def check(server: ProtocolServer) -> None:
                    args = ("--unprotected",) if kind == "mutation" else ()
                    r = s.run(
                        "api", document, *args, endpoint=server.endpoint, timeout=70
                    )
                    r.write(effect=effect, success=False)
                    server.count(1)
                    require(
                        r.seconds < 65, "body consumption exceeded the request deadline"
                    )

                s.protocol([Reply(body_delay=66)], check)

            add("transport.deadline-" + kind + "-body", ("api",), body_deadline)

    first = {
        "data": {"picked": connection([{"id": "one"}], after="cursor-1", more=True)},
        "extensions": {"trace": "keep"},
    }
    second = {
        "data": {"picked": connection([{"id": "two"}], after="cursor-2", more=True)}
    }
    third = {"data": {"picked": connection([{"id": "three"}], after="cursor-3")}}

    def pagination(s: Scenario) -> None:
        def check(server: ProtocolServer) -> None:
            doc = s.run("api", PAGES, "--paginate", endpoint=server.endpoint).document()
            equal(
                doc,
                {
                    "data": {
                        "picked": connection(
                            [{"id": "one"}, {"id": "two"}, {"id": "three"}],
                            after="cursor-3",
                        )
                    },
                    "extensions": {"trace": "keep"},
                },
            )
            server.count(3)
            equal(
                [r["body"]["variables"]["after"] for r in server.requests],
                [None, "cursor-1", "cursor-2"],
            )

        s.protocol([Reply(first), Reply(second), Reply(third)], check)

    add("pagination.all-pages-and-api-shape", ("api",), pagination)

    def truncation(s: Scenario) -> None:
        def check(server: ProtocolServer) -> None:
            r = s.run("api", PAGES, endpoint=server.endpoint)
            equal(r.document(), first)
            require(
                "picked" in r.stderr and "more pages" in r.stderr, "silent truncation"
            )
            server.count(1)

        s.protocol([Reply(first)], check)

    add("pagination.truncation-only-on-stderr", ("api",), truncation)

    bad_pages = [
        ("repeated-cursor", [first, first], 2),
        (
            "empty-next-cursor",
            [{"data": {"picked": connection([], after="", more=True)}}],
            1,
        ),
        ("missing-page-info", [{"data": {"picked": {"nodes": []}}}], 1),
        (
            "nodes-not-array",
            [{"data": {"picked": {"nodes": {}, "pageInfo": {"hasNextPage": False}}}}],
            1,
        ),
        (
            "later-page-errors",
            [
                first,
                {
                    "data": {"picked": connection([])},
                    "errors": [{"message": "page two failed"}],
                },
            ],
            2,
        ),
    ]
    for name, pages, count in bad_pages:

        def incomplete(
            s: Scenario, pages: list[dict] = pages, count: int = count
        ) -> None:
            def check(server: ProtocolServer) -> None:
                r = s.run("api", PAGES, "--paginate", endpoint=server.endpoint)
                require(r.code != 0, "incomplete pagination reported success")
                r.document(success=False)
                server.count(count)

            s.protocol([Reply(page) for page in pages], check)

        add("pagination.reject-" + name, ("api",), incomplete)

    return result
