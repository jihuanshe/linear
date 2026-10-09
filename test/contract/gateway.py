"""Unmodified live HTTP forwarding with credential-free request evidence."""

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Self
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class LinearGateway:
    def __init__(self):
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *_args: object) -> None:
                pass

            def do_POST(self) -> None:
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.loads(raw)
                # Record dispatch before contacting Linear, even if a reply is
                # lost. Authentication values never enter the evidence log.
                entry: dict = {"body": body, "started": time.monotonic()}
                with outer.lock:
                    outer.requests.append(entry)
                request = Request(
                    "https://api.linear.app/graphql",
                    data=raw,
                    headers={
                        "Content-Type": self.headers.get(
                            "Content-Type", "application/json"
                        ),
                        "Authorization": self.headers.get("Authorization", ""),
                        "User-Agent": self.headers.get("User-Agent", "linear-contract"),
                    },
                    method="POST",
                )
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


def mutations(requests: list[dict]) -> int:
    return sum(operation_kind(request["body"]) == "mutation" for request in requests)


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
