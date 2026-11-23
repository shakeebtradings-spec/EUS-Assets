"""The web boundary: one ASGI gate above the router.

* Host header is checked on EVERY request (defeats DNS rebinding).
* WebSockets and state-changing requests need an allowed Origin OR the tool token.
* No CORS headers are ever sent.
"""
import hmac
import os
from urllib.parse import urlparse

from data_paths import ensure_tool_token

LOOPBACK = {"localhost", "127.0.0.1", "::1", "[::1]"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
TOKEN_HEADER = "x-jarvis-token"
VITE_PORT = 5173


def _host_only(hostport: str) -> str:
    h = hostport.strip().lower()
    if h.startswith("["):
        return h.split("]")[0] + "]"
    return h.rsplit(":", 1)[0] if h.count(":") == 1 else h


class WebBoundary:
    def __init__(self, app, port: int | None = None, extra_origins: str | None = None,
                 extra_hosts: set[str] | None = None):
        self.app = app
        self.ports = {int(port or os.environ.get("JARVIS_PORT", 8340)), VITE_PORT}
        raw = extra_origins if extra_origins is not None else os.environ.get("JARVIS_ALLOWED_ORIGINS", "")
        self.extra_origins = {o.strip().rstrip("/").lower() for o in raw.split(",") if o.strip()}
        self.hosts = set(LOOPBACK) | {(urlparse(o).hostname or "").lower() for o in self.extra_origins}
        self.hosts |= set(extra_hosts or ())

    def _origin_ok(self, origin: str) -> bool:
        origin = origin.rstrip("/").lower()
        if origin in self.extra_origins:
            return True
        u = urlparse(origin)
        if u.scheme not in ("http", "https") or u.hostname is None:
            return False
        host = u.hostname if u.hostname != "::1" else "::1"
        return host in LOOPBACK and u.port in self.ports

    def _check(self, scope, headers) -> str | None:
        host = headers.get("host")
        if not host or _host_only(host) not in self.hosts:
            return "bad host"
        gated = scope["type"] == "websocket" or scope["method"] not in SAFE_METHODS
        if not gated:
            return None
        tok = headers.get(TOKEN_HEADER)
        if tok and hmac.compare_digest(tok, ensure_tool_token()):
            return None
        origin = headers.get("origin")
        if origin and self._origin_ok(origin):
            return None
        return "bad origin"

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        reason = self._check(scope, headers)
        if reason is None:
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            await receive()  # websocket.connect
            return await send({"type": "websocket.close", "code": 1008})
        body = b'{"detail":"forbidden"}'
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
