"""Sign-in attempts are rate limited per client address and per username."""

from dataclasses import replace

from fastapi.testclient import TestClient

from app import auth
from app.main import app
from app.routes import core


def _settings(monkeypatch) -> None:
    s = replace(core.settings, app_passwords={"rm": "Demo@123"}, app_secret="test-secret")
    monkeypatch.setattr(core, "settings", s)
    monkeypatch.setattr(auth, "settings", s)
    monkeypatch.setattr(core.crm, "audit", lambda *a, **k: None)
    core.reset_login_limiter()


def test_login_locks_after_ten_failures_and_clears_on_success(monkeypatch):
    _settings(monkeypatch)
    c = TestClient(app)
    for _ in range(core.LOGIN_MAX):
        assert c.post("/api/auth/login", json={"username": "rm", "password": "wrong"}).status_code == 401
    r = c.post("/api/auth/login", json={"username": "rm", "password": "wrong"})
    assert r.status_code == 429
    assert "Too many" in r.json()["detail"]
    # The right password is refused too while the window is open, which is the point of the limit.
    assert c.post("/api/auth/login", json={"username": "rm", "password": "Demo@123"}).status_code == 429
    core.reset_login_limiter()
    assert c.post("/api/auth/login", json={"username": "rm", "password": "Demo@123"}).status_code == 200
    core.reset_login_limiter()


def test_login_limit_is_per_address(monkeypatch):
    _settings(monkeypatch)
    c = TestClient(app)
    for i in range(core.LOGIN_MAX):
        c.post("/api/auth/login", json={"username": f"user{i}", "password": "wrong"}, headers={"x-forwarded-for": "10.0.0.9"})
    assert c.post("/api/auth/login", json={"username": "rm", "password": "wrong"}, headers={"x-forwarded-for": "10.0.0.9"}).status_code == 429
    assert c.post("/api/auth/login", json={"username": "rm", "password": "wrong"}, headers={"x-forwarded-for": "10.0.0.10"}).status_code == 401
    core.reset_login_limiter()
