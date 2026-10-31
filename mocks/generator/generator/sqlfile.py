"""Reads the DDL files in db/ so the generator and psql share one source of truth."""

import os
from pathlib import Path


def ddl_dir() -> Path:
    if os.environ.get("DDL_DIR"):
        return Path(os.environ["DDL_DIR"])
    # repo layout: mocks/generator/generator/sqlfile.py -> repo/db
    return Path(__file__).resolve().parents[3] / "db"


def statements(text: str) -> list[str]:
    """Split on ';' at line end, dropping comment-only lines and psql meta-commands."""
    out, buf = [], []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("--") or stripped.startswith("\\"):
            continue
        buf.append(line)
        if stripped.endswith(";"):
            out.append("\n".join(buf).rstrip().rstrip(";"))
            buf = []
    if buf:
        out.append("\n".join(buf))
    return out


def load(name: str) -> list[str]:
    return statements((ddl_dir() / name).read_text(encoding="utf-8"))


def load_sections(name: str) -> dict[str, list[str]]:
    """For mockdb.sql: statements grouped by the database named in each \\connect line."""
    sections: dict[str, list[str]] = {}
    current, lines = None, []
    for line in (ddl_dir() / name).read_text(encoding="utf-8").splitlines():
        if line.startswith("\\connect "):
            if current:
                sections[current] = statements("\n".join(lines))
            current, lines = line.split()[1], []
        elif current:
            lines.append(line)
    if current:
        sections[current] = statements("\n".join(lines))
    return sections
