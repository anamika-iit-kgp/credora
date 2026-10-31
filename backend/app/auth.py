"""Sign-in for the four demo users and HMAC-signed (HS256) bearer tokens."""

from __future__ import annotations

import datetime as dt
import hmac
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, Request

from .config import settings

ROLES = ("admin", "datasci", "loanops", "rm")

DISPLAY_NAMES = {
    "admin": "Kavita Menon",
    "datasci": "Arjun Iyer",
    "loanops": "Farah Siddiqui",
    "rm": "Relationship manager",
}


@dataclass(frozen=True)
class User:
    username: str
    role: str
    display_name: str
    rm_id: str | None = None

    def public(self) -> dict:
        out = {"username": self.username, "role": self.role, "display_name": self.display_name}
        if self.rm_id:
            out["rm_id"] = self.rm_id
        return out


def check_password(username: str, password: str) -> bool:
    expected = settings.app_passwords.get(username, "")
    if not expected or not password:
        return False
    return hmac.compare_digest(expected.encode(), password.encode())


def make_user(username: str, display_name: str | None = None) -> User:
    return User(
        username=username,
        role=username,  # one user per role; the username is the role
        display_name=display_name or DISPLAY_NAMES[username],
        rm_id=settings.rm_id if username == "rm" else None,
    )


def issue_token(user: User, now: dt.datetime | None = None) -> str:
    if not settings.app_secret:
        raise HTTPException(500, "APP_SECRET is not set on the server.")
    now = now or dt.datetime.now(dt.timezone.utc)
    claims = {
        "sub": user.username,
        "role": user.role,
        "name": user.display_name,
        "iat": int(now.timestamp()),
        "exp": int((now + dt.timedelta(hours=settings.token_hours)).timestamp()),
    }
    if user.rm_id:
        claims["rm_id"] = user.rm_id
    return jwt.encode(claims, settings.app_secret, algorithm="HS256")


def decode_token(token: str) -> User:
    try:
        c = jwt.decode(token, settings.app_secret, algorithms=["HS256"], options={"require": ["exp", "sub"]})
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(401, "Your session has expired. Sign in again.") from e
    except jwt.PyJWTError as e:
        raise HTTPException(401, "Sign in to continue.") from e
    if c.get("role") not in ROLES or c.get("sub") != c.get("role"):
        raise HTTPException(401, "Sign in to continue.")
    return User(username=c["sub"], role=c["role"], display_name=c.get("name") or DISPLAY_NAMES[c["role"]],
                rm_id=c.get("rm_id"))


def current_user(request: Request) -> User:
    h = request.headers.get("Authorization", "")
    if not h.lower().startswith("bearer ") or not settings.app_secret:
        raise HTTPException(401, "Sign in to continue.")
    return decode_token(h[7:].strip())


def require(*roles: str):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, f"The {user.role} role cannot use this endpoint.")
        return user

    return dep
