"""Disposable real-API workflows, independently verified through read-only HTTP."""

from __future__ import annotations

import getpass
import json
import os
import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from typing import TypeVar
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from gateway import LinearGateway, mutations, operation_kind, single_mutation_root
from harness import Scenario, equal, require

ENDPOINT = "https://api.linear.app/graphql"
T = TypeVar("T")
READ_FIELDS = {
    "issue": "id identifier title description priority estimate dueDate trashed parent { id } project { id } projectMilestone { id } assignee { id } labels { nodes { id name } pageInfo { hasNextPage endCursor } } comments { nodes { id body } pageInfo { hasNextPage endCursor } } relations { nodes { id type relatedIssue { id } } pageInfo { hasNextPage endCursor } }",
    "comment": "id body issue { id } parent { id } resolvedAt",
    "project": "id name description content archivedAt trashed teams { nodes { id } pageInfo { hasNextPage endCursor } }",
    "document": "id title content trashed project { id } initiative { id } issue { id }",
    "projectMilestone": "id name description targetDate project { id }",
    "initiative": "id name description content archivedAt trashed projects { nodes { id } pageInfo { hasNextPage endCursor } }",
    "issueLabel": "id name description color team { id }",
}
ENTITY_NAMES = {
    "issue": "Issue",
    "comment": "Comment",
    "project": "Project",
    "document": "Document",
    "projectMilestone": "ProjectMilestone",
    "initiative": "Initiative",
    "issueLabel": "IssueLabel",
}


CREATIONS = {
    "issueCreate": ("issue", "issue"),
    "commentCreate": ("comment", "comment"),
    "projectCreate": ("project", "project"),
    "projectMilestoneCreate": ("milestone", "projectMilestone"),
    "issueLabelCreate": ("label", "issueLabel"),
    "documentCreate": ("document", "document"),
    "initiativeCreate": ("initiative", "initiative"),
}


class LiveRun:
    def __init__(self, binary: Path, key: str, progress: Path | None = None):
        self.scenario = Scenario(binary, key=key)
        self.key = key
        self.prefix = "cli-contract-" + uuid.uuid4().hex[:12]
        self.steps: list[dict] = []
        self.oracle_reads: list[dict] = []
        self.resources: list[dict] = []
        self.cleanup_results: list[dict] = []
        self.workspace: dict = {}
        self.requests: list[dict] = []
        self.progress = progress
        self.intents: list[dict] = []
        self.file_evidence: dict = {}

    def save_progress(self) -> None:
        if self.progress is None:
            return
        self.progress.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.progress.with_name(
            self.progress.name + "." + uuid.uuid4().hex + ".tmp"
        )
        temporary.write_text(
            json.dumps(
                {
                    "prefix": self.prefix,
                    "workspace": self.workspace,
                    "steps": self.steps,
                    "resources": self.resources,
                    "cleanup": self.cleanup_results,
                    "intents": self.intents,
                },
                indent=2,
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        temporary.replace(self.progress)

    def reconcile_creations(self, start: int) -> None:
        """Retain every known create receipt, including duplicates rejected by an oracle."""
        for index, request in enumerate(self.requests[start:], start):
            if (
                not request.get("forwarded")
                or operation_kind(request["body"]) != "mutation"
            ):
                continue
            alias, field = single_mutation_root(request["body"])
            if field not in CREATIONS:
                continue
            domain, kind = CREATIONS[field]
            data = request.get("response", {}).get("data")
            payload = data.get(alias) if isinstance(data, dict) else None
            entity = payload.get(kind) if isinstance(payload, dict) else None
            if (
                isinstance(entity, dict)
                and isinstance(entity.get("id"), str)
                and entity["id"]
            ):
                if not any(
                    resource["kind"] == kind and resource["id"] == entity["id"]
                    for resource in self.resources
                ):
                    self.resources.append(
                        {
                            "domain": domain,
                            "kind": kind,
                            "id": entity["id"],
                            "name": self.prefix,
                            "requestIndex": index,
                        }
                    )
            else:
                self.intents.append(
                    {
                        "domain": domain,
                        "kind": kind,
                        "name": self.prefix,
                        "requestIndex": index,
                        "outcome": "unresolved-creation-receipt",
                    }
                )
        self.save_progress()

    def step(self, name: str, commands: list[str], check: Callable[[], T]) -> T:
        start = time.monotonic()
        before = len(self.requests)
        entry: dict = {
            "name": name,
            "commands": commands,
            "boundary": "live-kadoraba",
            "passed": False,
        }
        self.steps.append(entry)
        self.save_progress()
        try:
            value = check()
            expected_mutations = {
                "project-create-and-team-membership": 1,
                "milestone-create": 1,
                "team-label-create": 1,
                "issue-create-resolves-and-preserves-fields": 1,
                "protected-update-and-stdin": 1,
                "explicit-clears-and-label-removal": 1,
                "issue-parent-identity": 1,
                "comment-add-with-independent-read": 1,
                "comment-protection-and-list": 1,
                "comment-reply-resolve-and-reopen": 3,
                "relations-identity-idempotence-and-conflict": 2,
                "delivery-plan-guard-apply-and-replay": 2,
                "delivery-concurrent-executors": 1,
                "project-and-milestone-protected-updates": 2,
                "document-markdown-and-protection": 2,
                "initiative-content-protection-links-and-archive": 6,
            }.get(name, 0)
            equal(mutations(self.requests[before:]), expected_mutations)
            entry["passed"] = True
            return value
        except Exception as error:
            entry["error"] = f"{type(error).__name__}: {error}"
            raise
        finally:
            self.reconcile_creations(before)
            entry["seconds"] = time.monotonic() - start
            entry["requests"] = len(self.requests) - before
            entry["mutations"] = mutations(self.requests[before:])
            self.save_progress()
            print(
                f"{'PASS' if entry['passed'] else 'FAIL'} live.{name} ({entry['seconds']:.2f}s)",
                flush=True,
            )

    def read_query(self, query: str, variables: dict | None = None) -> dict:
        # Only read-only operations are sent by this oracle. All mutations use
        # the target CLI's dedicated commands and their public safety checks.
        require(
            query.lstrip().startswith("query "), "oracle only permits explicit queries"
        )
        payload = {"query": query, "variables": variables or {}}
        request = Request(
            ENDPOINT,
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": self.key,
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=20) as response:
                data = json.load(response)
        except HTTPError as error:
            data = json.loads(error.read())
        self.oracle_reads.append({"request": payload, "response": data})
        require(isinstance(data, dict), "oracle received a non-object response")
        return data

    def read(self, kind: str, object_id: str) -> dict | None:
        data = self.read_query(
            f"query ContractOracle($id: String!) {{ {kind}(id: $id) {{ {READ_FIELDS[kind]} }} }}",
            {"id": object_id},
        )
        if data.get("errors"):
            # A missing object is INPUT_ERROR in the observed Linear API.
            # Require the exact entity message and field path; an auth failure
            # or arbitrary INPUT_ERROR is never proof of deletion.
            if all(
                error.get("extensions", {}).get("code") == "INPUT_ERROR"
                and error.get("message") == "Entity not found: " + ENTITY_NAMES[kind]
                and error.get("path") == [kind]
                for error in data["errors"]
            ):
                return None
            raise AssertionError(f"independent read failed: {data['errors']!r}")
        require(kind in data.get("data", {}), f"oracle response omitted {kind}")
        return data["data"][kind]

    def verify(self, kind: str, object_id: str, expected: dict) -> dict:
        actual = None
        for attempt in range(4):
            actual = self.read(kind, object_id)
            if actual and all(
                actual.get(key) == value for key, value in expected.items()
            ):
                return actual
            if attempt < 3:
                time.sleep(0.4 * (attempt + 1))
        raise AssertionError(
            f"{kind} {object_id}: expected {expected!r}, actual {actual!r}"
        )

    def present(self, kind: str, object_id: str) -> dict:
        actual = self.read(kind, object_id)
        if actual is None:
            raise AssertionError(f"{kind} {object_id} unexpectedly disappeared")
        return actual

    def create(self, domain: str, field: str, *args: str, name: str) -> dict:
        intent: dict = {
            "domain": domain,
            "kind": field,
            "name": name,
            "outcome": "unknown",
        }
        self.intents.append(intent)
        self.save_progress()
        result = self.scenario.run(domain, "create", *args, "--json", timeout=45)
        document = result.document(success=result.code == 0)
        # Save a returned identity before asserting any other receipt field.
        data = document.get("data")
        entity = data.get(field) if isinstance(data, dict) else None
        if (
            isinstance(entity, dict)
            and isinstance(entity.get("id"), str)
            and entity["id"]
        ):
            self.resources.append(
                {"domain": domain, "kind": field, "id": entity["id"], "name": name}
            )
            intent.update({"id": entity["id"], "outcome": "identity-received"})
            self.save_progress()
        result.write()
        require(
            isinstance(entity, dict) and entity.get("id"),
            "created resource has no usable identity",
        )
        if not isinstance(entity, dict):
            raise AssertionError("created resource has no usable identity")
        return entity

    def cleanup(self) -> None:
        for resource in reversed(self.resources):
            entry = dict(resource, passed=False)
            self.cleanup_results.append(entry)
            self.save_progress()
            try:
                current = self.read(resource["kind"], resource["id"])
                if current is None or current.get("trashed") is True:
                    entry.update(
                        {
                            "passed": True,
                            "state": "absent" if current is None else "trashed",
                        }
                    )
                    self.save_progress()
                    continue
                if resource["kind"] == "comment":
                    parent_id = current["issue"]["id"]
                    require(
                        parent_id
                        in {
                            owned["id"]
                            for owned in self.resources
                            if owned["kind"] == "issue"
                        },
                        "refusing cleanup of an unowned comment",
                    )
                    parent = self.present("issue", parent_id)
                    require(
                        parent["title"].startswith(self.prefix),
                        "comment belongs to an unowned issue",
                    )
                else:
                    name = current.get("title", current.get("name", ""))
                    require(
                        name.startswith(self.prefix),
                        "refusing cleanup outside this run's unique namespace",
                    )
                args = [resource["domain"], "delete", resource["id"], "--yes", "--json"]
                if resource["domain"] == "comment":
                    args = ["issue", *args]
                result = self.scenario.run(*args, timeout=45)
                if result.code == 0:
                    result.write()
                # Deletion may return not-found if a preceding workflow already
                # removed it; independent absence is the cleanup acceptance.
                for attempt in range(5):
                    actual = self.read(resource["kind"], resource["id"])
                    deleted = actual is None or actual.get("trashed") is True
                    if deleted:
                        entry["passed"] = True
                        entry["state"] = "absent" if actual is None else "trashed"
                        break
                    if attempt < 4:
                        time.sleep(0.5)
                require(
                    entry["passed"], f"resource remains after cleanup: {resource!r}"
                )
            except Exception as error:
                entry["error"] = f"{type(error).__name__}: {error}"
            self.save_progress()
            print(
                f"{'PASS' if entry['passed'] else 'FAIL'} cleanup.{resource['domain']} {resource['id']}",
                flush=True,
            )

    def concurrent_delivery(self, issue: dict) -> None:
        s = self.scenario
        body = "Concurrent delivery " + self.prefix
        path = s.file(
            "concurrent/manifest.json",
            {
                "schemaVersion": 2,
                "workspace": self.workspace["urlKey"],
                "issues": [
                    {
                        "operation": "update",
                        "identifier": issue["id"],
                        "comments": [{"body": body}],
                    }
                ],
            },
        )
        args = (
            "issue",
            "apply",
            "--file",
            str(path),
            "--confirm-workspace",
            self.workspace["urlKey"],
            "--json",
        )
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(s.run, *args) for _ in range(2)]
            results = [future.result() for future in futures]
        documents = [result.document() for result in results]
        equal(sorted(document["effect"] for document in documents), ["applied", "none"])
        for document in documents:
            equal(document["ok"], True)
            equal(document["data"]["status"], "completed")
        remote = self.present("issue", issue["id"])
        matching = [
            node for node in remote["comments"]["nodes"] if node["body"] == body
        ]
        for comment in matching:
            self.resources.append(
                {
                    "domain": "comment",
                    "kind": "comment",
                    "id": comment["id"],
                    "name": self.prefix,
                }
            )
        self.save_progress()
        equal(len(matching), 1)
        ledger = json.loads(Path(str(path) + ".checkpoint.json").read_text())
        items = list(ledger["items"].values())
        require(
            items
            and all(
                item["status"] == "completed" and item.get("receipt") for item in items
            ),
            "concurrent receipt lost",
        )
        equal(
            [
                item["receipt"]["id"]
                for item in items
                if item["receipt"].get("kind") == "comment"
            ],
            [matching[0]["id"]],
        )
        equal(ledger["schemaVersion"], 2)
        equal(
            ledger["workspace"],
            {"id": self.workspace["id"], "urlKey": self.workspace["urlKey"]},
        )
        equal(
            sorted((item["receipt"]["kind"], item["receipt"]["id"]) for item in items),
            sorted((("issue", issue["id"]), ("comment", matching[0]["id"]))),
        )
        self.file_evidence["concurrent/checkpoint.json"] = ledger
        before = len(self.requests)
        replayed = s.run(*args).write(effect="none")
        equal(replayed["data"]["status"], "completed")
        equal(mutations(self.requests[before:]), 0)
        equal(json.loads(Path(str(path) + ".checkpoint.json").read_text()), ledger)
        equal(self.present("issue", issue["id"]), remote)
        require(
            Path(str(path) + ".checkpoint.json.lock").exists(),
            "delivery lock file was removed",
        )

    def workflow(self) -> None:
        s = self.scenario

        def identity() -> dict:
            viewer = s.run("auth", "whoami", "--json", timeout=30).document()
            organization = viewer["organization"]
            require(
                organization.get("name") == "Kadoraba"
                or organization.get("urlKey") == "kadoraba",
                f"refusing live writes in workspace {organization.get('name')!r}",
            )
            self.workspace = organization
            independent = self.read_query(
                "query ContractIdentity { organization { id name urlKey } viewer { id } }"
            )
            require(not independent.get("errors"), "independent identity read failed")
            equal(independent["data"]["organization"]["id"], organization["id"])
            equal(independent["data"]["viewer"]["id"], viewer["id"])
            return viewer

        viewer = self.step("workspace-identity", ["auth whoami"], identity)

        def catalog() -> dict:
            teams = s.run(
                "team", "list", "--limit", "0", "--json", timeout=30
            ).document()
            equal(teams["pageInfo"]["hasNextPage"], False)
            require(teams["nodes"], "Kadoraba needs at least one team")
            team = teams["nodes"][0]
            states = s.run("team", "states", team["key"], "--json").document()
            oracle = self.read_query(
                "query ContractCatalog($id: String!) { team(id: $id) { id states { nodes { id name type position } } members { nodes { id name active } pageInfo { hasNextPage } } } users(first: 250) { nodes { id name active } pageInfo { hasNextPage } } }",
                {"id": team["id"]},
            )
            require(not oracle.get("errors"), "catalog oracle failed")
            catalog_data = oracle["data"]
            equal(
                sorted(states["nodes"], key=lambda item: item["id"]),
                sorted(
                    catalog_data["team"]["states"]["nodes"], key=lambda item: item["id"]
                ),
            )
            members = s.run("team", "members", team["key"], "--json").document()
            require(
                "nodes" in members and "pageInfo" in members,
                "member connection lost API shape",
            )
            users = s.run("user", "list", "--json").document()
            for actual, expected in (
                (members, catalog_data["team"]["members"]),
                (users, catalog_data["users"]),
            ):
                equal(expected["pageInfo"]["hasNextPage"], False)
                equal(actual["pageInfo"]["hasNextPage"], False)
                equal(
                    sorted(
                        (node["id"], node["name"], node["active"])
                        for node in actual["nodes"]
                    ),
                    sorted(
                        (node["id"], node["name"], node["active"])
                        for node in expected["nodes"]
                        if node["active"]
                    ),
                )
            return team

        team = self.step(
            "team-user-catalogs",
            ["team list", "team states", "team members", "user list"],
            catalog,
        )
        body = f"Contract {self.prefix} 中文 🧪\n\nA second paragraph.\n\n```text\n$() `literal`\n```"

        def project_create() -> dict:
            project = self.create(
                "project",
                "project",
                "--name",
                self.prefix,
                "--team",
                team["key"],
                "--description",
                "Disposable executable acceptance",
                "--content",
                body,
                name=self.prefix,
            )
            remote = self.verify(
                "project", project["id"], {"name": self.prefix, "content": body}
            )
            require(
                team["id"] in [node["id"] for node in remote["teams"]["nodes"]],
                "wrong project team",
            )
            displayed = s.run("project", "teams", project["id"], "--json").document()
            equal(displayed["id"], project["id"])
            equal(
                sorted(node["id"] for node in displayed["teams"]["nodes"]),
                sorted(node["id"] for node in remote["teams"]["nodes"]),
            )
            equal(displayed["teams"]["pageInfo"]["hasNextPage"], False)
            return project

        project = self.step(
            "project-create-and-team-membership",
            ["project create", "project teams"],
            project_create,
        )

        def milestone_create() -> dict:
            milestone = self.create(
                "milestone",
                "projectMilestone",
                "--project",
                project["id"],
                "--name",
                self.prefix,
                "--description",
                "契约 milestone",
                "--target-date",
                "2030-01-15",
                name=self.prefix,
            )
            self.verify(
                "projectMilestone",
                milestone["id"],
                {"name": self.prefix, "targetDate": "2030-01-15"},
            )
            return milestone

        milestone = self.step(
            "milestone-create", ["milestone create"], milestone_create
        )

        def label_create() -> dict:
            label = self.create(
                "label",
                "issueLabel",
                "--team",
                team["key"],
                "--name",
                self.prefix,
                "--color",
                "#5E6AD2",
                name=self.prefix,
            )
            self.verify(
                "issueLabel",
                label["id"],
                {"name": self.prefix, "team": {"id": team["id"]}},
            )
            return label

        label = self.step("team-label-create", ["label create"], label_create)

        def issue_create() -> dict:
            issue = self.create(
                "issue",
                "issue",
                "--team",
                team["key"],
                "--title",
                self.prefix + " primary",
                "--project",
                project["id"],
                "--milestone",
                milestone["id"],
                "--label",
                label["id"],
                "--priority",
                "HIGH",
                "--assignee",
                "self",
                "--due-date",
                "2030-01-10",
                "--description-file",
                str(s.file("create.md", body)),
                name=self.prefix + " primary",
            )
            remote = self.verify(
                "issue",
                issue["id"],
                {
                    "title": self.prefix + " primary",
                    "priority": 2,
                    "description": body,
                    "project": {"id": project["id"]},
                    "projectMilestone": {"id": milestone["id"]},
                    "assignee": {"id": viewer["id"]},
                    "dueDate": "2030-01-10",
                },
            )
            equal([node["id"] for node in remote["labels"]["nodes"]], [label["id"]])
            return issue

        issue = self.step(
            "issue-create-resolves-and-preserves-fields", ["issue create"], issue_create
        )

        def reads() -> dict:
            original = s.run("issue", "view", issue["id"], "--json").document()
            equal(original["organization"]["id"], self.workspace["id"])
            equal(original["issue"]["id"], issue["id"])
            equal(original["issue"]["description"], body)
            for reference in (issue["identifier"], issue["url"]):
                read = s.run("issue", "view", reference, "-j").document()
                equal(read["issue"]["id"], issue["id"])
            for field in ("comments", "attachments", "documents"):
                connection = original["issue"][field]
                require(
                    "nodes" in connection and "pageInfo" in connection,
                    f"{field} lost connection shape",
                )
                equal(connection["pageInfo"]["hasNextPage"], False)
            exported = s.run(
                "issue",
                "export",
                issue["id"],
                "--output",
                str(s.cwd / "exported"),
                "--json",
            ).document()
            equal(Path(exported["descriptionFile"]), s.cwd / "exported" / "desired.md")
            equal(Path(exported["baseFile"]), s.cwd / "exported" / "original.json")
            equal(Path(exported["descriptionFile"]).read_text(), body)
            equal(
                json.loads(Path(exported["baseFile"]).read_text())["issue"]["id"],
                issue["id"],
            )
            s.run(
                "issue",
                "export",
                issue["id"],
                "--output",
                str(s.cwd / "exported"),
                "--json",
            ).write(effect="none", success=False)
            equal(Path(exported["descriptionFile"]).read_text(), body)
            self.file_evidence["exported/original.json"] = json.loads(
                Path(exported["baseFile"]).read_text()
            )
            self.file_evidence["exported/desired.md"] = Path(
                exported["descriptionFile"]
            ).read_text()
            return original

        original = self.step(
            "issue-identities-connections-and-export",
            ["issue view", "issue export"],
            reads,
        )
        base = s.file("original.json", original)

        def protected_update() -> None:
            changed = body + "\n\nUpdated from stdin."
            r = s.run(
                "issue",
                "update",
                issue["id"],
                "--title",
                self.prefix + " updated",
                "--description-file",
                "-",
                "--priority",
                "low",
                "--base-file",
                str(base),
                "--json",
                stdin=changed,
                timeout=40,
            ).write()
            equal(r["verification"]["status"], "verified")
            self.verify(
                "issue",
                issue["id"],
                {
                    "title": self.prefix + " updated",
                    "priority": 4,
                    "description": changed,
                },
            )

        self.step("protected-update-and-stdin", ["issue update"], protected_update)

        def stale_conflict() -> None:
            s.run(
                "issue",
                "update",
                issue["id"],
                "--title",
                self.prefix + " rejected",
                "--base-file",
                str(base),
                "--json",
            ).write(effect="none", success=False)
            self.verify("issue", issue["id"], {"title": self.prefix + " updated"})

        self.step("stale-basis-cannot-overwrite", ["issue update"], stale_conflict)

        def idempotent() -> None:
            before = self.read("issue", issue["id"])
            s.run(
                "issue",
                "update",
                issue["id"],
                "--title",
                self.prefix + " updated",
                "--base-file",
                str(base),
                "--json",
            ).write(effect="none")
            equal(self.read("issue", issue["id"]), before)

        self.step("already-desired-is-idempotent", ["issue update"], idempotent)

        def wrong_object_basis() -> None:
            wrong = dict(original, issue=dict(original["issue"], id=str(uuid.uuid4())))
            path = s.file("wrong-object.json", wrong)
            s.run(
                "issue",
                "update",
                issue["id"],
                "--title",
                "should fail",
                "--base-file",
                str(path),
                "--json",
            ).write(effect="none", success=False)
            self.verify("issue", issue["id"], {"title": self.prefix + " updated"})

        self.step("basis-bound-to-object", ["issue update"], wrong_object_basis)

        def clear_fields() -> None:
            current = s.run("issue", "view", issue["id"], "--json").document()
            path = s.file("clear-base.json", current)
            s.run(
                "issue",
                "update",
                issue["id"],
                "--description",
                "",
                "--unassign",
                "--clear-project",
                "--remove-label",
                label["id"],
                "--base-file",
                str(path),
                "--json",
                timeout=40,
            ).write()
            remote = self.verify(
                "issue",
                issue["id"],
                {
                    "description": "",
                    "assignee": None,
                    "project": None,
                    "projectMilestone": None,
                },
            )
            equal(remote["labels"]["nodes"], [])

        self.step("explicit-clears-and-label-removal", ["issue update"], clear_fields)

        def create_child() -> dict:
            child = self.create(
                "issue",
                "issue",
                "--team",
                team["key"],
                "--title",
                self.prefix + " child",
                "--parent",
                issue["identifier"],
                "--project",
                project["id"],
                name=self.prefix + " child",
            )
            self.verify("issue", child["id"], {"parent": {"id": issue["id"]}})
            return child

        child = self.step("issue-parent-identity", ["issue create"], create_child)

        def comment_add() -> dict:
            comment_body = "Discussion 中文 🧪\n\nNo notifications or uploads."
            r = s.run(
                "issue",
                "comment",
                "add",
                issue["id"],
                "--body-file",
                "-",
                "--json",
                stdin=comment_body,
            ).document()
            comment = r["data"]["comment"]
            self.resources.append(
                {
                    "domain": "comment",
                    "kind": "comment",
                    "id": comment["id"],
                    "name": self.prefix,
                }
            )
            equal(r["ok"], True)
            equal(r["effect"], "applied")
            self.verify(
                "comment",
                comment["id"],
                {"body": comment_body, "issue": {"id": issue["id"]}},
            )
            return comment

        comment = self.step(
            "comment-add-with-independent-read", ["issue comment add"], comment_add
        )

        def comment_update() -> None:
            original_comment = s.run(
                "issue", "comment", "view", comment["id"], "--json"
            ).document()
            base_comment = s.file("comment-base.json", original_comment)
            s.run(
                "issue",
                "comment",
                "update",
                comment["id"],
                "--body",
                "Updated discussion 中文",
                "--base-file",
                str(base_comment),
                "--json",
            ).write()
            self.verify("comment", comment["id"], {"body": "Updated discussion 中文"})
            s.run(
                "issue",
                "comment",
                "update",
                comment["id"],
                "--body",
                "stale",
                "--base-file",
                str(base_comment),
                "--json",
            ).write(effect="none", success=False)
            self.verify("comment", comment["id"], {"body": "Updated discussion 中文"})
            listing = s.run(
                "issue", "comment", "list", issue["id"], "--limit", "0", "--json"
            ).document()
            require(
                comment["id"] in [node["id"] for node in listing["nodes"]],
                "created comment missing from list",
            )
            equal(listing["pageInfo"]["hasNextPage"], False)

        self.step(
            "comment-protection-and-list",
            ["issue comment view", "issue comment update", "issue comment list"],
            comment_update,
        )

        def comment_resolution() -> None:
            result = s.run(
                "issue",
                "comment",
                "add",
                issue["id"],
                "--parent",
                comment["id"],
                "--body",
                "Resolution " + self.prefix,
                "--json",
            ).write()
            reply = result["data"]["comment"]
            self.resources.append(
                {
                    "domain": "comment",
                    "kind": "comment",
                    "id": reply["id"],
                    "name": self.prefix,
                }
            )
            self.verify(
                "comment",
                reply["id"],
                {"parent": {"id": comment["id"]}, "issue": {"id": issue["id"]}},
            )
            s.run(
                "issue",
                "comment",
                "resolve",
                comment["id"],
                "--resolving-comment",
                reply["id"],
                "--json",
            ).write()
            require(
                self.present("comment", comment["id"])["resolvedAt"],
                "thread was not resolved",
            )
            view = s.run("issue", "view", issue["id"], "--json").document()
            require(
                comment["id"]
                in [node["id"] for node in view["issue"]["comments"]["nodes"]],
                "view omitted a resolved thread",
            )
            s.run("issue", "comment", "unresolve", comment["id"], "--json").write()
            self.verify("comment", comment["id"], {"resolvedAt": None})

        self.step(
            "comment-reply-resolve-and-reopen",
            [
                "issue comment add",
                "issue comment resolve",
                "issue comment unresolve",
                "issue view",
            ],
            comment_resolution,
        )

        def relations() -> None:
            s.run(
                "issue",
                "relation",
                "add",
                issue["id"],
                "related",
                child["id"],
                "--json",
            ).write()
            before = self.present("issue", issue["id"])["relations"]["nodes"]
            equal(len(before), 1)
            equal(before[0]["relatedIssue"]["id"], child["id"])
            s.run(
                "issue",
                "relation",
                "add",
                issue["id"],
                "related",
                child["id"],
                "--json",
            ).write(effect="none")
            equal(self.present("issue", issue["id"])["relations"]["nodes"], before)
            s.run(
                "issue", "relation", "add", issue["id"], "blocks", child["id"], "--json"
            ).write(effect="none", success=False)
            displayed = s.run(
                "issue", "relation", "list", issue["id"], "--json"
            ).document()["issue"]
            equal(displayed["id"], issue["id"])
            equal(displayed["relations"]["pageInfo"]["hasNextPage"], False)
            equal(
                [
                    (node["id"], node["type"], node["relatedIssue"]["id"])
                    for node in displayed["relations"]["nodes"]
                ],
                [
                    (node["id"], node["type"], node["relatedIssue"]["id"])
                    for node in before
                ],
            )
            s.run(
                "issue",
                "relation",
                "delete",
                issue["id"],
                "related",
                child["id"],
                "--json",
            ).write()
            equal(self.present("issue", issue["id"])["relations"]["nodes"], [])
            s.run(
                "issue",
                "relation",
                "delete",
                issue["id"],
                "related",
                child["id"],
                "--json",
            ).write(effect="none")

        self.step(
            "relations-identity-idempotence-and-conflict",
            ["issue relation add", "issue relation list", "issue relation delete"],
            relations,
        )

        def query_reconciliation() -> None:
            missing = team["key"] + "-999999999"
            query = s.run(
                "issue",
                "query",
                "--id",
                child["identifier"],
                "--id",
                issue["identifier"],
                "--id",
                child["identifier"],
                "--id",
                missing,
                "--json",
            ).document()
            equal([node["id"] for node in query["nodes"]], [child["id"], issue["id"]])
            equal(query["reconciliation"], {"requested": 3, "read": 2, "missing": 1})
            equal(query["pageInfo"]["hasNextPage"], False)
            scoped = s.run(
                "issue",
                "query",
                "--team",
                team["key"],
                "--project",
                project["id"],
                "--limit",
                "0",
                "--json",
            ).document()
            equal([node["id"] for node in scoped["nodes"]], [child["id"]])

        self.step(
            "query-order-dedup-and-missing-accounting",
            ["issue query"],
            query_reconciliation,
        )

        def real_pagination() -> None:
            query = "query ContractPages($after: String, $ids: [ID!]) { issues(first: 1, after: $after, filter: {id: {in: $ids}}) { nodes {id title} pageInfo {hasNextPage endCursor} } }"
            variables = json.dumps({"ids": [issue["id"], child["id"]]})
            page = s.run("api", query, "--variables-json", variables)
            equal(page.document()["data"]["issues"]["pageInfo"]["hasNextPage"], True)
            require("more pages" in page.stderr, "live API truncation was silent")
            document = s.run(
                "api", query, "--variables-json", variables, "--paginate"
            ).document()
            equal(
                {node["id"] for node in document["data"]["issues"]["nodes"]},
                {issue["id"], child["id"]},
            )
            equal(document["data"]["issues"]["pageInfo"]["hasNextPage"], False)

        self.step("real-api-pagination", ["api"], real_pagination)

        def delivery() -> None:
            current = s.run("issue", "view", issue["id"], "--json").document()
            path = s.file(
                "delivery/manifest.json",
                {
                    "schemaVersion": 2,
                    "workspace": self.workspace["urlKey"],
                    "issues": [
                        {
                            "operation": "update",
                            "identifier": issue["id"],
                            "base": current,
                            "set": {"title": self.prefix + " delivered"},
                            "comments": [{"body": "Delivery receipt " + self.prefix}],
                        }
                    ],
                },
            )
            before = self.read("issue", issue["id"])
            plan = s.run("issue", "plan", "--file", str(path), "--json").document()
            equal(plan["status"], "ready")
            equal(self.read("issue", issue["id"]), before)
            require(
                not Path(str(path) + ".checkpoint.json").exists(),
                "plan wrote an execution ledger",
            )
            s.run(
                "issue",
                "apply",
                "--file",
                str(path),
                "--confirm-workspace",
                "wrong-contract-workspace",
                "--json",
            ).write(effect="none", success=False)
            equal(self.read("issue", issue["id"]), before)
            args = (
                "issue",
                "apply",
                "--file",
                str(path),
                "--confirm-workspace",
                self.workspace["urlKey"],
                "--json",
            )
            applied = s.run(*args, timeout=45).write()
            equal(applied["data"]["status"], "completed")
            require(
                all(
                    entry["status"] == "verified"
                    for entry in applied["data"]["verification"]
                ),
                "delivery unverified",
            )
            remote = self.verify(
                "issue", issue["id"], {"title": self.prefix + " delivered"}
            )
            comments = [
                node
                for node in remote["comments"]["nodes"]
                if node["body"] == "Delivery receipt " + self.prefix
            ]
            equal(len(comments), 1)
            self.resources.append(
                {
                    "domain": "comment",
                    "kind": "comment",
                    "id": comments[0]["id"],
                    "name": self.prefix,
                }
            )
            ledger = json.loads(Path(str(path) + ".checkpoint.json").read_text())
            self.file_evidence["delivery/checkpoint-after-apply.json"] = ledger
            equal(ledger["schemaVersion"], 2)
            require(ledger["items"], "empty ledger")
            require(
                all(
                    item["status"] == "completed" and item.get("receipt")
                    for item in ledger["items"].values()
                ),
                "lost delivery receipt",
            )
            resumed = s.run(*args, timeout=45).write(effect="none")
            equal(resumed["data"]["status"], "completed")
            equal(self.read("issue", issue["id"]), remote)
            equal(json.loads(Path(str(path) + ".checkpoint.json").read_text()), ledger)
            self.file_evidence["delivery/checkpoint-after-replay.json"] = json.loads(
                Path(str(path) + ".checkpoint.json").read_text()
            )

        self.step(
            "delivery-plan-guard-apply-and-replay",
            ["issue plan", "issue apply"],
            delivery,
        )

        self.step(
            "delivery-concurrent-executors",
            ["issue apply"],
            lambda: self.concurrent_delivery(issue),
        )

        def domain_updates() -> None:
            for domain, field, entity, option, value in (
                ("project", "project", project, "--name", self.prefix + " changed"),
                (
                    "milestone",
                    "projectMilestone",
                    milestone,
                    "--name",
                    self.prefix + " changed",
                ),
            ):
                saved = s.run(domain, "view", entity["id"], "--json").document()
                path = s.file(domain + "-base.json", saved)
                s.run(
                    domain,
                    "update",
                    entity["id"],
                    option,
                    value,
                    "--base-file",
                    str(path),
                    "--json",
                ).write()
                self.verify(field, entity["id"], {"name": value})
                s.run(
                    domain,
                    "update",
                    entity["id"],
                    option,
                    "stale",
                    "--base-file",
                    str(path),
                    "--json",
                ).write(effect="none", success=False)
                self.verify(field, entity["id"], {"name": value})

        self.step(
            "project-and-milestone-protected-updates",
            ["project view", "project update", "milestone view", "milestone update"],
            domain_updates,
        )

        def documents() -> None:
            document = self.create(
                "document",
                "document",
                "--title",
                self.prefix,
                "--project",
                project["id"],
                "--content-file",
                str(s.file("document.md", body)),
                name=self.prefix,
            )
            self.verify(
                "document",
                document["id"],
                {
                    "title": self.prefix,
                    "content": body,
                    "project": {"id": project["id"]},
                },
            )
            saved = s.run("document", "view", document["id"], "--json").document()
            path = s.file("document-base.json", saved)
            s.run(
                "document",
                "update",
                document["id"],
                "--title",
                self.prefix + " changed",
                "--base-file",
                str(path),
                "--json",
            ).write()
            self.verify("document", document["id"], {"title": self.prefix + " changed"})
            s.run(
                "document",
                "update",
                document["id"],
                "--title",
                "stale",
                "--base-file",
                str(path),
                "--json",
            ).write(effect="none", success=False)
            self.verify("document", document["id"], {"title": self.prefix + " changed"})

        self.step(
            "document-markdown-and-protection",
            ["document create", "document view", "document update"],
            documents,
        )

        def initiatives() -> None:
            initiative = self.create(
                "initiative",
                "initiative",
                "--name",
                self.prefix,
                "--content",
                body,
                name=self.prefix,
            )
            self.verify(
                "initiative", initiative["id"], {"name": self.prefix, "content": body}
            )
            saved = s.run("initiative", "view", initiative["id"], "--json").document()
            path = s.file("initiative-base.json", saved)
            s.run(
                "initiative",
                "update",
                initiative["id"],
                "--name",
                self.prefix + " changed",
                "--base-file",
                str(path),
                "--json",
            ).write()
            self.verify(
                "initiative", initiative["id"], {"name": self.prefix + " changed"}
            )
            s.run(
                "initiative",
                "update",
                initiative["id"],
                "--name",
                "stale",
                "--base-file",
                str(path),
                "--json",
            ).write(effect="none", success=False)
            self.verify(
                "initiative", initiative["id"], {"name": self.prefix + " changed"}
            )
            s.run(
                "initiative", "add-project", initiative["id"], project["id"], "--json"
            ).write()
            remote = self.present("initiative", initiative["id"])
            equal([node["id"] for node in remote["projects"]["nodes"]], [project["id"]])
            s.run(
                "initiative", "add-project", initiative["id"], project["id"], "--json"
            ).write(effect="none")
            s.run(
                "initiative",
                "remove-project",
                initiative["id"],
                project["id"],
                "--yes",
                "--json",
            ).write()
            equal(self.present("initiative", initiative["id"])["projects"]["nodes"], [])
            s.run("initiative", "archive", initiative["id"], "--yes", "--json").write()
            require(
                self.present("initiative", initiative["id"])["archivedAt"],
                "archive did not land",
            )
            s.run(
                "initiative", "unarchive", initiative["id"], "--yes", "--json"
            ).write()
            self.verify("initiative", initiative["id"], {"archivedAt": None})

        self.step(
            "initiative-content-protection-links-and-archive",
            [
                "initiative create",
                "initiative view",
                "initiative update",
                "initiative add-project",
                "initiative remove-project",
                "initiative archive",
                "initiative unarchive",
            ],
            initiatives,
        )

        def schema() -> None:
            path = s.cwd / "schema.json"
            r = s.run("schema", "--json", "--output", str(path), timeout=30)
            equal(r.code, 0)
            equal(r.stdout, "")
            data = json.loads(path.read_text())
            require(data["__schema"]["types"], "empty schema file")

        self.step("schema-file-has-no-stdout-noise", ["schema"], schema)


def run_live(binary: Path, *, progress: Path | None = None) -> dict:
    key = (
        os.environ["LINEAR_KADORABA_API_KEY"]
        if "LINEAR_KADORABA_API_KEY" in os.environ
        else getpass.getpass(
            "Kadoraba API key (hidden; disposable objects only): ",
        )
    )
    run = LiveRun(binary, key, progress)
    error = None
    started = time.monotonic()
    with LinearGateway() as gateway:
        run.requests = gateway.requests
        run.scenario.env["LINEAR_GRAPHQL_ENDPOINT"] = gateway.endpoint
        try:
            run.workflow()
        except Exception as exception:
            error = f"{type(exception).__name__}: {exception}"
        finally:
            if run.resources:
                run.cleanup()
        report = {
            "prefix": run.prefix,
            "workspace": run.workspace,
            "passed": error is None
            and not any(
                intent["outcome"] == "unresolved-creation-receipt"
                for intent in run.intents
            )
            and all(entry["passed"] for entry in run.cleanup_results),
            "error": error,
            "seconds": time.monotonic() - started,
            "steps": run.steps,
            "resources": run.resources,
            "intents": run.intents,
            "fileEvidence": run.file_evidence,
            "cleanup": run.cleanup_results,
            "processes": [asdict(result) for result in run.scenario.results],
            "oracleReads": run.oracle_reads,
            "requests": run.requests,
            "behaviorCommands": sorted(
                {
                    command
                    for step in run.steps
                    if step["passed"]
                    for command in step["commands"]
                }
            ),
        }
    run.scenario.close()
    run.key = ""
    if error:
        print(f"Live acceptance failed: {error}", flush=True)
    return report
