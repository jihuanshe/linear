"""Unmodified live HTTP forwarding with credential-free request evidence."""

import json
import re
import threading
import time
import uuid
from collections.abc import Generator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Self
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from harness import request_body


class LinearGateway:
    def __init__(
        self, *, upstream: str = "https://api.linear.app/graphql", chunked: bool = False
    ):
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        self._mutations_enabled = False
        self._commands: dict[str, bool] = {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *_args: object) -> None:
                pass

            def do_POST(self) -> None:
                raw = request_body(self)
                body = json.loads(raw)
                # Record dispatch before contacting Linear, even if a reply is
                # lost. Authentication values never enter the evidence log.
                entry: dict = {
                    "body": body,
                    "started": time.monotonic(),
                    "forwarded": False,
                }
                with outer.lock:
                    outer.requests.append(entry)
                try:
                    with outer.lock:
                        if self.path != "/graphql" and self.path not in outer._commands:
                            raise ValueError("inactive live command permission")
                        may_write = outer._commands.get(self.path, False)
                        verified = outer._mutations_enabled
                    if operation_kind(body) == "mutation":
                        if not verified:
                            raise ValueError("workspace identity is not verified")
                        if not may_write:
                            raise ValueError("live command is read-only")
                        single_mutation_root(body)
                except (AssertionError, ValueError) as error:
                    # Refuse unaccounted writes before they reach real Linear.
                    # This is an experiment safety boundary, not CLI validation.
                    entry["rejected"] = str(error)
                    payload = json.dumps({"errors": [{"message": str(error)}]}).encode()
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                request = Request(
                    upstream,
                    data=iter((raw[:3], raw[3:])) if chunked else raw,
                    headers={
                        "Content-Type": self.headers.get(
                            "Content-Type", "application/json"
                        ),
                        "Authorization": self.headers.get("Authorization", ""),
                        "User-Agent": self.headers.get("User-Agent", "linear-contract"),
                    },
                    method="POST",
                )
                entry["forwarded"] = True
                try:
                    with urlopen(request, timeout=65) as response:
                        payload = response.read()
                        status = response.status
                        headers = response.headers
                except HTTPError as error:
                    payload = error.read()
                    status = error.code
                    headers = error.headers
                except OSError:
                    # Do not manufacture a GraphQL error or imply no write.
                    self.close_connection = True
                    entry["connectionLost"] = True
                    return
                finally:
                    entry["seconds"] = time.monotonic() - entry["started"]
                entry["status"] = status
                try:
                    entry["response"] = json.loads(payload)
                except ValueError:
                    entry["response"] = {
                        "rawBody": payload.decode("utf-8", errors="replace")
                    }
                try:
                    self.send_response(status)
                    self.send_header(
                        "Content-Type", headers.get("Content-Type", "application/json")
                    )
                    self.send_header("Content-Length", str(len(payload)))
                    if headers.get("Retry-After"):
                        self.send_header("Retry-After", headers["Retry-After"])
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    entry["clientDisconnected"] = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )

    def __enter__(self) -> Self:
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/graphql"

    def enable_mutations(self) -> None:
        """Called only after both identity reads and their step checks pass."""
        with self.lock:
            self._mutations_enabled = True

    @contextmanager
    def command(self, *, may_write: bool) -> Generator[str, None, None]:
        """Scope permission to one subprocess, including concurrent executors."""
        path = "/graphql/" + uuid.uuid4().hex
        with self.lock:
            self._commands[path] = may_write
        try:
            yield f"http://127.0.0.1:{self.server.server_port}{path}"
        finally:
            with self.lock:
                del self._commands[path]


def mutations(requests: list[dict]) -> int:
    return sum(
        request.get("forwarded", True) and operation_kind(request["body"]) == "mutation"
        for request in requests
    )


def single_mutation_root(body: dict) -> tuple[str, str]:
    """Conservative live guard: one direct root response key per mutation.

    Root fragments and batching are intentionally refused before dispatch until
    the suite can independently account for and clean every resulting write.
    Nested fragments and aliases do not constrain the implementation.
    """
    scanned = re.findall(
        r'"""(?:\\.|(?!""").)*"""|"(?:\\.|[^"\\])*"|#[^\r\n]*|\.\.\.|[A-Za-z_]\w*|[{}():@]',
        body["query"],
        re.DOTALL,
    )
    tokens = [token for token in scanned if not token.startswith(('"', "#"))]

    def closing(start: int, left: str, right: str) -> int:
        depth = 1
        for index in range(start + 1, len(tokens)):
            if tokens[index] == left:
                depth += 1
            elif tokens[index] == right:
                depth -= 1
                if not depth:
                    return index
        raise ValueError("incomplete selection in live mutation")

    index = 0
    selections: list[int] = []
    while index < len(tokens):
        token = tokens[index]
        kind = (
            token
            if token in ("query", "mutation", "subscription", "fragment")
            else "query"
        )
        name = tokens[index + 1] if token != "{" and index + 1 < len(tokens) else None
        if name in ("(", "{"):
            name = None
        while index < len(tokens) and tokens[index] != "{":
            if tokens[index] == "(":
                index = closing(index, "(", ")")
            index += 1
        if index == len(tokens):
            break
        end = closing(index, "{", "}")
        if kind == "mutation" and (
            not body.get("operationName") or name == body["operationName"]
        ):
            selections.append(index)
        index = end + 1
    if len(selections) != 1:
        raise ValueError("cannot identify one selected live mutation")
    index = selections[0] + 1
    end = closing(selections[0], "{", "}")
    fields: dict[str, str] = {}
    while index < end:
        token = tokens[index]
        if token == "...":
            raise ValueError(
                "live safety guard does not yet support root mutation fragments"
            )
        if not re.fullmatch(r"[A-Za-z_]\w*", token):
            raise ValueError("cannot account for live mutation fields")
        index += 1
        field_name = token
        if tokens[index] == ":":
            field_name = tokens[index + 1]
            index += 2
        fields[token] = field_name
        while index < end and tokens[index] in ("(", "@"):
            if tokens[index] == "@":
                index += 2
            if index < end and tokens[index] == "(":
                index = closing(index, "(", ")") + 1
        if index < end and tokens[index] == "{":
            index = closing(index, "{", "}") + 1
    if len(fields) != 1:
        raise ValueError(
            "live safety guard requires one root mutation field; batching is not yet supported"
        )
    return next(iter(fields.items()))


def operation_kind(body: dict) -> str:
    """Read top-level operation headers, independent of names/formatting.

    This is a wire accounting lexer, not schema validation or an API model.
    Linear itself parses and validates each forwarded business document.
    """
    scanned = re.findall(
        r'"""(?:\\.|(?!""").)*"""|"(?:\\.|[^"\\])*"|#[^\r\n]*|[A-Za-z_]\w*|[{}()]',
        body["query"],
        re.DOTALL,
    )
    tokens = [token for token in scanned if not token.startswith(('"', "#"))]
    braces = parentheses = 0
    operations: list[tuple[str, str | None]] = []
    header = False
    for index, token in enumerate(tokens):
        if braces == 0 and parentheses == 0:
            if not header and token in ("query", "mutation", "subscription"):
                name = tokens[index + 1] if index + 1 < len(tokens) else ""
                operations.append(
                    (token, name if re.fullmatch(r"[A-Za-z_]\w*", name) else None)
                )
                header = True
            elif not header and token == "fragment":
                header = True
            elif token == "{":
                if not header:
                    operations.append(("query", None))
                header = False
        if token == "{":
            braces += 1
        elif token == "}":
            braces -= 1
        elif token == "(" and braces == 0:
            parentheses += 1
        elif token == ")" and braces == 0:
            parentheses -= 1
    selected = [
        kind
        for kind, name in operations
        if body.get("operationName") is None or name == body["operationName"]
    ]
    if len(selected) != 1:
        raise AssertionError(
            "cannot account for an ambiguously selected live operation"
        )
    return selected[0]
