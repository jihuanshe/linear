"""A subprocess/wire harness with no dependency on the CLI implementation."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Self


def request_body(handler: BaseHTTPRequestHandler) -> bytes:
    """Decode HTTP framing without constraining the executable's client library."""
    if handler.headers.get("Transfer-Encoding", "").lower() == "chunked":
        parts: list[bytes] = []
        while True:
            line = handler.rfile.readline()
            if not line:
                raise ValueError("incomplete chunk header")
            length = int(line.split(b";", 1)[0], 16)
            if length == 0:
                while handler.rfile.readline() not in (b"\r\n", b"\n", b""):
                    pass
                return b"".join(parts)
            chunk = handler.rfile.read(length)
            if len(chunk) != length or handler.rfile.read(2) != b"\r\n":
                raise ValueError("incomplete chunk body")
            parts.append(chunk)
    return handler.rfile.read(int(handler.headers.get("Content-Length", "0")))


def require(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def equal(actual: object, expected: object) -> None:
    require(actual == expected, f"expected {expected!r}, received {actual!r}")


@dataclass
class Result:
    args: list[str]
    code: int
    stdout: str
    stderr: str
    seconds: float

    def _json(self, *, success: bool = True) -> dict | list:
        if success:
            equal(self.code, 0)
        else:
            require(self.code != 0, "invalid/failed command exited successfully")
        try:
            value = json.loads(self.stdout)
        except ValueError as error:
            raise AssertionError(
                f"stdout is not one JSON document: {self.stdout!r}"
            ) from error
        require(isinstance(value, (dict, list)), "expected a JSON object or array")
        require("\x1b" not in self.stdout, "ANSI escapes in machine output")
        return value

    def document(self, *, success: bool = True) -> dict:
        value = self._json(success=success)
        if not isinstance(value, dict):
            raise AssertionError("expected a JSON object")
        return value

    def array(self) -> list:
        value = self._json()
        if not isinstance(value, list):
            raise AssertionError("expected a JSON array")
        return value

    def write(self, *, effect: str = "applied", success: bool = True) -> dict:
        value = self.document(success=success)
        require(isinstance(value, dict), "write result must be an object")
        equal(value.get("ok"), success)
        equal(value.get("effect"), effect)
        return value


@dataclass
class Reply:
    body: object = field(default_factory=lambda: {"data": {"viewer": {"id": "probe"}}})
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    disconnect: bool = False
    delay: float = 0
    body_delay: float = 0


class ProtocolServer:
    """Scripted transport only: no GraphQL parser, routing model, or fake domain."""

    def __init__(self, replies: list[Reply]):
        self.replies = replies
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *_args: object) -> None:
                pass

            def parse_request(self) -> bool:
                accepted = super().parse_request()
                if accepted:
                    with outer.lock:
                        self.index = len(outer.requests)
                        self.entry = {
                            "method": self.command,
                            "path": self.path,
                            "body": None,
                            "authenticated": self.headers.get("Authorization")
                            == "offline-contract-key",
                            "contentType": self.headers.get("Content-Type"),
                            "transferEncoding": self.headers.get("Transfer-Encoding"),
                            "at": time.monotonic(),
                        }
                        outer.requests.append(self.entry)
                return accepted

            def do_POST(self) -> None:
                raw = request_body(self)
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = raw.decode("utf-8", errors="replace")
                with outer.lock:
                    index = self.index
                    self.entry["body"] = body
                    reply = (
                        outer.replies[index]
                        if index < len(outer.replies)
                        else Reply(
                            {"errors": [{"message": "Unexpected extra request"}]},
                            status=500,
                        )
                    )
                if reply.disconnect:
                    self.close_connection = True
                    return
                if reply.delay:
                    time.sleep(reply.delay)
                payload = (
                    reply.body
                    if isinstance(reply.body, str)
                    else json.dumps(
                        reply.body,
                        ensure_ascii=False,
                    )
                ).encode()
                try:
                    self.send_response(reply.status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    for key, value in reply.headers.items():
                        self.send_header(key, value)
                    self.end_headers()
                    if reply.body_delay:
                        self.wfile.write(payload[:1])
                        self.wfile.flush()
                        time.sleep(reply.body_delay)
                        payload = payload[1:]
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

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

    def count(self, expected: int) -> None:
        equal(len(self.requests), expected)
        for request in self.requests:
            equal(request["path"], "/graphql")
            equal(request["authenticated"], True)
            require(
                "application/json" in request["contentType"],
                "missing JSON content type",
            )


class Scenario:
    def __init__(self, binary: Path, *, key: str | None = None):
        self.binary = binary
        self.temporary = tempfile.TemporaryDirectory(prefix="linear-contract-")
        self.root = Path(self.temporary.name)
        self.cwd = self.root / "cwd"
        self.cwd.mkdir()
        self.results: list[Result] = []
        self.wire: list[dict] = []
        self.discovered_commands: list[str] = []
        self.discovery_gaps: list[str] = []
        self.live = key is not None
        # Deliberately select allowed names, never inspect the existing API key.
        self.env = {
            name: os.environ[name]
            for name in (
                "PATH",
                "SystemRoot",
                "WINDIR",
                "TMPDIR",
                "TEMP",
                "TMP",
            )
            if name in os.environ
        }
        self.env.update(
            {
                "HOME": str(self.root / "home"),
                "USERPROFILE": str(self.root / "home"),
                "XDG_CONFIG_HOME": str(self.root / "config"),
                "APPDATA": str(self.root / "config"),
                "NO_COLOR": "1",
                "TERM": "dumb",
                "TZ": "UTC",
                "LINEAR_VCS": "git",
            }
        )
        if key is not None:
            self.env["LINEAR_API_KEY"] = key

    def close(self) -> None:
        self.env.pop("LINEAR_API_KEY", None)
        self.temporary.cleanup()

    def run(
        self,
        *args: str,
        stdin: str = "",
        timeout: float = 20,
        endpoint: str | None = None,
        extra_env: dict[str, str] | None = None,
    ) -> Result:
        env = self.env | (extra_env or {})
        if endpoint is not None:
            env.update(
                {
                    "LINEAR_GRAPHQL_ENDPOINT": endpoint,
                    "LINEAR_API_KEY": "offline-contract-key",
                }
            )
        start = time.monotonic()
        try:
            process = subprocess.run(
                [str(self.binary), *args],
                cwd=self.cwd,
                env=env,
                input=stdin,
                capture_output=True,
                encoding="utf-8",
                # Live transport owns its deadline. Never kill a real mutation
                # to manufacture an unknown outcome; faults are offline only.
                timeout=None if self.live else timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise AssertionError(
                f"command exceeded {timeout}s: {list(args)!r}"
            ) from error
        result = Result(
            list(args),
            process.returncode,
            process.stdout,
            process.stderr,
            time.monotonic() - start,
        )
        self.results.append(result)
        return result

    def file(self, name: str, content: object) -> Path:
        path = self.cwd / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            content
            if isinstance(content, str)
            else json.dumps(
                content,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return path

    def protocol(
        self, replies: list[Reply], check: Callable[[ProtocolServer], None]
    ) -> None:
        with ProtocolServer(replies) as server:
            try:
                check(server)
            finally:
                self.wire.extend(server.requests)


@dataclass
class Case:
    name: str
    commands: tuple[str, ...]
    check: Callable[[Scenario], None]
    boundary: str = "offline-protocol"


def connection(
    nodes: list[dict], *, after: str | None = None, more: bool = False
) -> dict:
    return {"nodes": nodes, "pageInfo": {"hasNextPage": more, "endCursor": after}}
