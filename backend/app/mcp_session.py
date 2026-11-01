"""Start the official Exasol MCP server (exasol-mcp-server 2.3.0) for one Ask Credora question, with
Credora's client name on every connection it opens.

The MCP server has no setting for a client name, so this wrapper, run with the MCP server's own
Python (`/opt/exasol-mcp/bin/python -I mcp_session.py`, see app/assistant.py server_command), wraps
pyexasol.connect before starting the server unchanged. It sets client_name to CREDORA_CLIENT_NAME
(credora:<app user>:ask-credora), so Exasol's audit log (EXA_DBA_AUDIT_SESSIONS.CLIENT) names the
person and the AI behind every statement.

The AI's limits are not set here. The server logs in as the person's AI session user
(CREDORA_<ROLE>_AI), and that user's consumer group CREDORA_AI carries the statement timeout and
the memory limit (exasol/sql/16_resources.sql). CREDORA_SESSION_SQL, a JSON list of statements to
run when a connection opens, stays as a hook for a deployment that needs one. It is empty by
default and the backend does not set it.

It imports only pyexasol and the MCP server: it runs in the MCP server's virtual environment, not
the API's.
"""

from __future__ import annotations

import json
import os
import sys

import pyexasol

_connect = pyexasol.connect
CLIENT_NAME = os.environ.get("CREDORA_CLIENT_NAME", "credora:ai:ask-credora")
SESSION_SQL = json.loads(os.environ.get("CREDORA_SESSION_SQL") or "[]")


def connect(*args, **kwargs):
    kwargs.setdefault("client_name", CLIENT_NAME)
    kwargs.setdefault("client_version", "1")
    kwargs.setdefault("client_os_username", "credora-ask")
    conn = _connect(*args, **kwargs)
    for sql in SESSION_SQL:
        conn.execute(sql)
    return conn


pyexasol.connect = connect

if __name__ == "__main__":
    from exasol.ai.mcp.server.main import main

    sys.exit(main())
