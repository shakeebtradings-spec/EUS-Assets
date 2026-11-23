import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import server
from brain import Brain
from data_paths import ensure_tool_token


@pytest.fixture
def client():
    return TestClient(server.build(), base_url="http://localhost:8340")


def test_read_with_good_host_needs_no_origin(client):
    assert client.get("/api/health").status_code == 200


def test_bad_host_rejected_even_for_reads(client):
    assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 403


def test_post_without_origin_rejected(client):
    assert client.post("/api/runs", json={"prompt": "x"}).status_code == 403


def test_post_with_foreign_origin_rejected(client):
    r = client.post("/api/runs", json={"prompt": "x"}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403


def test_post_with_vite_origin_passes_gate(client):
    r = client.post("/api/runs", json={"prompt": " "}, headers={"origin": "http://localhost:5173"})
    assert r.status_code == 400  # got past the gate, failed validation


def test_token_passes_gate(client):
    r = client.post("/internal/tool", json={"name": "nope"}, headers={"x-jarvis-token": ensure_tool_token()})
    assert r.status_code == 404


def test_wrong_token_rejected(client):
    assert client.post("/internal/tool", json={}, headers={"x-jarvis-token": "wrong"}).status_code == 403


def test_websocket_needs_origin(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/runs", headers={"host": "localhost:8340"}):
            pass
    with client.websocket_connect("/ws/runs", headers={"host": "localhost:8340", "origin": "http://localhost:5173"}):
        pass


def test_no_cors_headers_and_no_docs(client):
    r = client.get("/api/health", headers={"origin": "http://localhost:5173"})
    assert "access-control-allow-origin" not in r.headers
    assert client.get("/docs").status_code == 404


def test_extra_origin_and_host(monkeypatch):
    monkeypatch.setenv("JARVIS_ALLOWED_ORIGINS", "http://mac.local:5173")
    c = TestClient(server.build(), base_url="http://mac.local:8340")
    r = c.post("/api/runs", json={"prompt": " "}, headers={"origin": "http://mac.local:5173"})
    assert r.status_code == 400
