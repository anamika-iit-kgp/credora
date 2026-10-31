"""Runtime settings, read once from the environment.

Defaults are right for the app host's docker compose network; a local run overrides
EXASOL_HOST, PG_HOST/PG_PORT and the MOCK_*_URL / GENERATOR_URL variables.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class Settings:
    app_secret: str = field(default_factory=lambda: _env("APP_SECRET"))
    token_hours: int = field(default_factory=lambda: int(_env("TOKEN_HOURS", "12")))

    # Web logins, one per role (usernames are fixed: admin, datasci, loanops, rm)
    app_passwords: dict[str, str] = field(default_factory=lambda: {
        "admin": _env("APP_ADMIN_PASSWORD"),
        "datasci": _env("APP_DATASCI_PASSWORD"),
        "loanops": _env("APP_LOANOPS_PASSWORD"),
        "rm": _env("APP_RM_PASSWORD"),
    })
    # Public demo: the login page may show the demo passwords (all data is synthetic).
    public_demo: bool = field(default_factory=lambda: _env("PUBLIC_DEMO", "true").lower() == "true")
    # The relationship manager the "rm" demo login acts as (an rm_id in cif.rm).
    rm_id: str = field(default_factory=lambda: _env("APP_RM_ID", "RM001"))

    # Exasol
    exasol_host: str = field(default_factory=lambda: _env("EXASOL_HOST", "localhost"))
    exasol_port: str = field(default_factory=lambda: _env("EXASOL_PORT", "8563"))
    # SHA-256 fingerprint of Exasol's self-signed TLS certificate (the launcher prints it). When set,
    # every connection pins it: a different certificate is refused. The deploy tool passes it in
    # (deploy/remote/exasol_fingerprint -> .env.runtime); empty falls back to no certificate check.
    exasol_fingerprint: str = field(default_factory=lambda: _env("EXASOL_FINGERPRINT").upper())
    exa_passwords: dict[str, str] = field(default_factory=lambda: {
        "CREDORA_SVC": _env("EXA_SVC_PASSWORD"),
        "CREDORA_ADMIN": _env("EXA_ADMIN_PASSWORD"),
        "CREDORA_DATASCI": _env("EXA_DATASCI_PASSWORD"),
        "CREDORA_LOANOPS": _env("EXA_LOANOPS_PASSWORD"),
        "CREDORA_RM": _env("EXA_RM_PASSWORD"),
    })
    exa_pool_size: int = field(default_factory=lambda: int(_env("EXA_POOL_SIZE", "3")))
    # Read-only Exasol user of the "Ask Credora" assistant, used only by the Exasol MCP server
    exa_mcp_password: str = field(default_factory=lambda: _env("EXA_MCP_PASSWORD"))
    # Command that starts the Exasol MCP server over stdio; empty picks exasol-mcp-server on PATH
    # (the Docker image) or else `uvx exasol-mcp-server@2.3.0`
    mcp_server_cmd: str = field(default_factory=lambda: _env("MCP_SERVER_CMD"))

    # Bank PostgreSQL (database crm is owned by this backend)
    pg_host: str = field(default_factory=lambda: _env("PG_HOST", "localhost"))
    pg_port: str = field(default_factory=lambda: _env("PG_PORT", "5432"))
    pg_user: str = field(default_factory=lambda: _env("PG_USER", "credora_admin"))
    pg_password: str = field(default_factory=lambda: _env("PG_PASSWORD"))
    pg_crm_db: str = field(default_factory=lambda: _env("PG_CRM_DB", "crm"))
    pg_sslmode: str = field(default_factory=lambda: _env("PG_SSLMODE", "require"))

    # Mock external APIs and the generator (docker network names by default)
    generator_url: str = field(default_factory=lambda: _env("GENERATOR_URL", "http://generator:8100"))
    cibil_url: str = field(default_factory=lambda: _env("MOCK_CIBIL_URL", "http://cibil:8101"))
    gstn_url: str = field(default_factory=lambda: _env("MOCK_GSTN_URL", "http://gstn:8102"))
    aa_url: str = field(default_factory=lambda: _env("MOCK_AA_URL", "http://aa:8103"))
    mock_api_token: str = field(default_factory=lambda: _env("MOCK_API_TOKEN"))

    # The Exasol Scheduler runs CREDORA.PURGE_EXPIRED every 15 minutes (exasol/sql/17_scheduler.sql).
    # Fallback switch only: a value > 0 makes the API run it too, every N minutes. Off by default.
    purge_interval_min: int = field(default_factory=lambda: int(_env("PURGE_INTERVAL_MIN", "0")))

    # Optional AI features
    ai_provider: str = field(default_factory=lambda: _env("AI_PROVIDER").lower())
    ai_model: str = field(default_factory=lambda: _env("AI_MODEL"))
    anthropic_api_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"))
    aws_region: str = field(default_factory=lambda: _env("AWS_REGION", _env("AWS_DEFAULT_REGION", "ap-south-1")))


settings = Settings()
