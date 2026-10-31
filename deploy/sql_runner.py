"""Run Credora's Exasol SQL files: ${VAR} substitution and statement splitting.

A statement ends with ';' at the end of a line. A CREATE ... SCRIPT statement ends with
a line holding only '/', as in Exasol's own SQL clients.
"""

from __future__ import annotations

import pathlib
import re
import string

SCRIPT_START = re.compile(r"^\s*CREATE\s+(OR\s+REPLACE\s+)?(\w+\s+)*SCRIPT\b", re.I)


def split(sql: str) -> list[str]:
    stmts, buf, in_script = [], [], False
    for line in sql.splitlines():
        if not buf and not line.strip():
            continue
        if not buf and line.lstrip().startswith("--"):
            continue
        if not buf and SCRIPT_START.match(line):
            in_script = True
        if in_script and line.strip() == "/":
            stmts.append("\n".join(buf) + "\n/\n")
            buf, in_script = [], False
            continue
        buf.append(line)
        if not in_script and line.rstrip().endswith(";"):
            stmts.append("\n".join(buf).rstrip().rstrip(";"))
            buf = []
    if "".join(buf).strip():
        stmts.append("\n".join(buf))
    return stmts


def render(path: pathlib.Path, values: dict[str, str]) -> str:
    return string.Template(path.read_text(encoding="utf-8")).substitute(values)


def run_file(conn, path: pathlib.Path, values: dict[str, str] | None = None, quiet: bool = False) -> None:
    text = render(path, values or {}) if values is not None else path.read_text(encoding="utf-8")
    for stmt in split(text):
        if not quiet:
            first = stmt.strip().splitlines()[0][:90]
            print(f"    {first}")
        conn.execute(stmt)
