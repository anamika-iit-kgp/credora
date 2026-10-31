"""Install Credora's Exasol extensions: Rust SLC, virtual schema adapters, drivers.

Everything is fetched from upstream releases at pinned versions, cached in
deploy/.cache, and uploaded to BucketFS. Re-running is safe: files that are
already in BucketFS with the same size are skipped.
"""

from __future__ import annotations

import base64
import hashlib
import os
import pathlib
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile

import pyexasol
import requests
import urllib3

import sql_runner

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CACHE = pathlib.Path(__file__).parent / ".cache"

RUST_SLC_VERSION = "0.23.1"  # must match exasol-udf-sdk used by adbc-vs-rs
ADBC_VS_VERSION = "v0.7.0"
ORACLE_VS_VERSION = "6.0.0"
ORACLE_VS_JAR = "virtual-schema-dist-14.1.1-oracle-6.0.0.jar"
OJDBC_VERSION = "23.9.0.25.07"

# SQL preprocessing: preprocessor-framework owns Exasol's single sql_preprocessor_script slot and
# dispatches to modules; exasol-semantic-views is the semantic layer, plugged in as one module.
PREPROC_VERSION = "v0.9.1"
PREPROC_SQL = f"preprocessor-framework-{PREPROC_VERSION}.sql"
SEMVIEWS_VERSION = "v0.5.1"
SEMVIEWS_ZIP = f"exasol-semantic-views-{SEMVIEWS_VERSION}.zip"
# exasol-labs/preprocessor-library: ready-made TRANSLATE modules, installed by the framework itself
# (PREPROC.MODULE_INSTALL, the procedure behind `PREPROC INSTALL MODULE`). Pinned to an immutable
# release tag; the framework verifies each artifact against the sha256 in that release's index, and
# we check the installed sha256 against the pins below as well.
PREPROC_LIB_VERSION = "v0.3.1"
PREPROC_LIB_INDEX = (f"https://raw.githubusercontent.com/exasol-labs/preprocessor-library/"
                     f"{PREPROC_LIB_VERSION}/registry/index.json")
PREPROC_LIB_MODULES = {  # module: (script, entry function, artifact sha256 in the pinned index)
    "cast_shorthand": ("PREPROC_RT.CAST_SHORTHAND_V1", "cast_shorthand",
                       "1ff0c225ae0d0988283ab9f16de394af7546fe870ce9b6c9493ed9a531339ada"),
    "trailing_comma": ("PREPROC_RT.ERGONOMICS_TRAILING_COMMA_V2", "trailing_comma",
                       "44f3bd0fb721107530b7cbc81e7765b97196ceafbe64fd700583c6d6800a8354"),
}
# The roles whose sessions send SQL written by Ask Credora's AI (each role user runs its own MCP
# server; R_MCP is the fallback user). R_SVC gets no rule: the app's own SQL is never rewritten.
AI_SQL_ROLES = ("R_ADMIN", "R_DATASCI", "R_LOANOPS", "R_RM", "R_MCP")

DOWNLOADS = {
    "lc-rust.tar.gz": f"https://github.com/exasol-labs/language-container-rs/releases/download/v{RUST_SLC_VERSION}/lc-rust-{RUST_SLC_VERSION}.tar.gz",
    "adbc-vs.tar.gz": f"https://github.com/exasol-labs/adbc-vs-rs/releases/download/{ADBC_VS_VERSION}/adbc-vs.tar.gz",
    ORACLE_VS_JAR: f"https://github.com/exasol/oracle-virtual-schema/releases/download/{ORACLE_VS_VERSION}/{ORACLE_VS_JAR}",
    "ojdbc17.jar": f"https://repo1.maven.org/maven2/com/oracle/database/jdbc/ojdbc17/{OJDBC_VERSION}/ojdbc17-{OJDBC_VERSION}.jar",
    PREPROC_SQL: f"https://github.com/exasol-labs/preprocessor-framework/releases/download/{PREPROC_VERSION}/release.sql",
    SEMVIEWS_ZIP: f"https://github.com/exasol-labs/exasol-semantic-views/releases/download/{SEMVIEWS_VERSION}/{SEMVIEWS_ZIP}",
}
SHA256 = {  # the release assets, pinned by content as well as by tag
    PREPROC_SQL: "8bb8219ac944aaaa8616a32a6c759c303a75b606901f30343adc9a35a7f3facf",
    SEMVIEWS_ZIP: "9676f433c8856020cf72ffe44fb9ae66fc6796627a81538cde8711a7561ba663",
}

ORACLE_SETTINGS_CFG = """DRIVERNAME=ORACLE
JAR=ojdbc17.jar
DRIVERMAIN=oracle.jdbc.driver.OracleDriver
PREFIX=jdbc:oracle:thin:
NOSECURITY=YES
FETCHSIZE=100000
INSERTSIZE=-1
"""


def fetch(name: str) -> pathlib.Path:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / name
    if not path.exists():
        print(f"  downloading {name}")
        with requests.get(DOWNLOADS[name], stream=True, timeout=600) as r:
            r.raise_for_status()
            tmp = path.with_suffix(".part")
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
            tmp.rename(path)
    if name in SHA256:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != SHA256[name]:
            path.unlink()
            raise RuntimeError(f"{name}: sha256 {digest} does not match the pinned {SHA256[name]}")
    return path


class Exasol:
    """Connection details for one Exasol Personal deployment on AWS."""

    def __init__(self, host: str, db_user: str, db_password: str, ssh_key: str, bucket: str = "default",
                 private_ip: str = "172.30.1.11"):
        self.host = host
        self.private_ip = private_ip  # what UDFs on the node use to reach BucketFS
        self.db_user = db_user
        self.db_password = db_password
        self.ssh_key = ssh_key
        self.bucket = bucket
        self._bfs_password: str | None = None

    # --- SQL ---------------------------------------------------------------

    def connect(self, **kw) -> pyexasol.ExaConnection:
        c = pyexasol.connect(
            dsn=f"{self.host}:8563", user=self.db_user, password=self.db_password,
            websocket_sslopt={"cert_reqs": ssl.CERT_NONE}, compression=True, **kw,
        )
        # Deploy sessions run DDL and admin scripts: keep the system SQL preprocessor out of them.
        c.execute("ALTER SESSION SET SQL_PREPROCESSOR_SCRIPT = ''")
        return c

    # --- host access ---------------------------------------------------------

    def ssh(self, command: str) -> str:
        out = subprocess.run(
            ["ssh", "-i", self.ssh_key, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20",
             f"ubuntu@{self.host}", command],
            capture_output=True, text=True, check=True,
        )
        return out.stdout

    # --- BucketFS -------------------------------------------------------------

    @property
    def bfs_password(self) -> str:
        """Read the bucket write password from the cluster configuration."""
        if self._bfs_password is None:
            info = self.ssh("c4 connect -s cos -i 1 -- confd_client bucketfs_info bucketfs_name: bfsdefault")
            line = next(l for l in info.splitlines() if l.strip().startswith("write_passwd:"))
            self._bfs_password = base64.b64decode(line.split(":", 1)[1].strip()).decode()
        return self._bfs_password

    def _url(self, path: str) -> str:
        return f"https://{self.host}:2581/{self.bucket}/{path}"

    def bfs_list(self) -> set[str]:
        r = requests.get(f"https://{self.host}:2581/{self.bucket}/", auth=("r", self.bfs_password), verify=False, timeout=60)
        if r.status_code == 403:  # read password differs from write password on some setups
            r = requests.get(f"https://{self.host}:2581/{self.bucket}/", auth=("w", self.bfs_password), verify=False, timeout=60)
        r.raise_for_status()
        return set(r.text.split())

    def bfs_put(self, path: str, data: bytes | pathlib.Path) -> None:
        body = data.read_bytes() if isinstance(data, pathlib.Path) else data
        r = requests.put(self._url(path), data=body, auth=("w", self.bfs_password), verify=False, timeout=900)
        r.raise_for_status()

    def bfs_wait(self, path: str, timeout: int = 600) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if path in self.bfs_list():
                return
            time.sleep(5)
        raise TimeoutError(f"BucketFS never showed {path}")

    def bfs_extracted(self, path: str, timeout: int = 600) -> None:
        """Wait until BucketFS has unpacked an uploaded archive (not visible in the HTTP listing)."""
        target = f"/exa/data/bucketfs/bfsdefault/.dest/{self.bucket}/{path}"
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if target in self.ssh(f"c4 connect -s cos -i 1 -- ls {target}"):
                    return
            except subprocess.CalledProcessError:
                pass
            time.sleep(5)
        raise TimeoutError(f"BucketFS never unpacked {path}")

    def bfs_url(self) -> str:
        """BucketFS address as seen from inside the cluster (UDFs, adapters)."""
        return f"https://{self.private_ip}:2581/{self.bucket}"


# --- install steps ---------------------------------------------------------


def install_rust_slc(ex: Exasol) -> None:
    """Rust language container pinned to the SDK version adbc-vs-rs was built with."""
    if "slc/rustslc.tar.gz" not in ex.bfs_list():
        print("  uploading Rust SLC")
        ex.bfs_put("slc/rustslc.tar.gz", fetch("lc-rust.tar.gz"))
    ex.bfs_extracted("slc/rustslc/exaudf/exaudfclient")
    alias = (f"RUST=localzmq+protobuf:///bfsdefault/{ex.bucket}/slc/rustslc?lang=rust"
             f"#buckets/bfsdefault/{ex.bucket}/slc/rustslc/exaudf/exaudfclient")
    register_language(ex, "RUST", alias)


def register_language(ex: Exasol, name: str, alias: str) -> None:
    with ex.connect() as c:
        current = c.execute("SELECT SYSTEM_VALUE FROM EXA_PARAMETERS WHERE PARAMETER_NAME='SCRIPT_LANGUAGES'").fetchval()
        parts = [p for p in current.split() if not p.startswith(f"{name}=")]
        new = " ".join(parts + [alias])
        if new != current:
            c.execute(f"ALTER SYSTEM SET SCRIPT_LANGUAGES='{new}'")
            c.execute(f"ALTER SESSION SET SCRIPT_LANGUAGES='{new}'")
            print(f"  registered language {name}")


def install_adbc_vs(ex: Exasol) -> None:
    """adbc-vs-rs: one shared library serves both the adapter and the scan UDF."""
    path = "udf/libadbc_vs_adapter.so"
    if path not in ex.bfs_list():
        with tarfile.open(fetch("adbc-vs.tar.gz")) as t:
            lib = t.extractfile("udf/libadbc_vs_adapter.so").read()
        ex.bfs_put(path, lib)
        ex.bfs_wait(path)
    lib_path = f"/buckets/bfsdefault/{ex.bucket}/{path}"
    with ex.connect() as c:
        c.execute("CREATE SCHEMA IF NOT EXISTS ADBC_VS")
        c.execute(f"CREATE OR REPLACE RUST ADAPTER SCRIPT ADBC_VS.ADBC_ADAPTER AS\n%udf_object {lib_path};\n")
        c.execute("CREATE OR REPLACE RUST SCALAR SCRIPT ADBC_VS.ADBC_SCAN(scan_spec VARCHAR(2000000)) EMITS (...) AS\n"
                  f"%udf_object {lib_path};\n")
        # adbc-vs-rs downloads the PostgreSQL and MySQL ADBC drivers into BucketFS on first use.
        c.execute(f"CREATE OR REPLACE CONNECTION ADBC_VS_BUCKETFS TO '{ex.bfs_url()}' "
                  f"USER 'w' IDENTIFIED BY '{ex.bfs_password}'")


def install_oracle_vs(ex: Exasol) -> None:
    """Exasol's Oracle virtual schema (Java) plus the Oracle JDBC driver for ExaLoader."""
    files = ex.bfs_list()
    if f"vs/{ORACLE_VS_JAR}" not in files:
        ex.bfs_put(f"vs/{ORACLE_VS_JAR}", fetch(ORACLE_VS_JAR))
    if "drivers/jdbc/ojdbc17.jar" not in files:
        ex.bfs_put("drivers/jdbc/ojdbc17.jar", fetch("ojdbc17.jar"))
    ex.bfs_put("drivers/jdbc/settings.cfg", ORACLE_SETTINGS_CFG.encode())
    ex.bfs_wait(f"vs/{ORACLE_VS_JAR}")
    ex.bfs_wait("drivers/jdbc/ojdbc17.jar")
    b = f"/buckets/bfsdefault/{ex.bucket}"
    with ex.connect() as c:
        c.execute("CREATE SCHEMA IF NOT EXISTS ADAPTER")
        c.execute("CREATE OR REPLACE JAVA ADAPTER SCRIPT ADAPTER.ORACLE_ADAPTER AS\n"
                  "  %scriptclass com.exasol.adapter.RequestDispatcher;\n"
                  f"  %jar {b}/vs/{ORACLE_VS_JAR};\n"
                  f"  %jar {b}/drivers/jdbc/ojdbc17.jar;\n/\n")


ROLE_USERS = {  # database user: (role, key of its password in the runtime secret)
    "CREDORA_SVC": ("R_SVC", "EXA_SVC_PASSWORD"),
    "CREDORA_ADMIN": ("R_ADMIN", "EXA_ADMIN_PASSWORD"),
    "CREDORA_DATASCI": ("R_DATASCI", "EXA_DATASCI_PASSWORD"),
    "CREDORA_LOANOPS": ("R_LOANOPS", "EXA_LOANOPS_PASSWORD"),
    "CREDORA_RM": ("R_RM", "EXA_RM_PASSWORD"),
    "CREDORA_MCP": ("R_MCP", "EXA_MCP_PASSWORD"),
}


def create_roles(ex: Exasol) -> None:
    with ex.connect() as c:
        existing = {r[0] for r in c.execute("SELECT ROLE_NAME FROM EXA_DBA_ROLES").fetchall()}
        for role in {r for r, _ in ROLE_USERS.values()} - existing:
            c.execute(f"CREATE ROLE {role}")


def create_users(ex: Exasol, secret: dict) -> None:
    """One Exasol user per app role; passwords come from the deployment's runtime secret."""
    with ex.connect() as c:
        existing = {r[0] for r in c.execute("SELECT USER_NAME FROM EXA_DBA_USERS").fetchall()}
        for user, (role, key) in ROLE_USERS.items():
            verb = "ALTER" if user in existing else "CREATE"
            c.execute(f'{verb} USER {user} IDENTIFIED BY "{secret[key]}"')
            c.execute(f"GRANT {role} TO {user}")


# --- SQL preprocessing: preprocessor-framework + exasol-semantic-views -----------------


def _one(c: pyexasol.ExaConnection, sql: str):
    row = c.execute(sql).fetchone()
    return row[0] if row else None


def install_preprocessor_framework(ex: Exasol) -> None:
    """preprocessor-framework: PREPROC (admin) and PREPROC_RT (runtime) schemas and PREPROC_RT.MASTER.

    The release's release.sql is a clean-install artifact (its CREATE ROLE is unguarded), so it
    runs once. The installed release is recorded as the comment on schema PREPROC; a different
    pin is reported, never re-applied over the live rules (see docs/WHY_EXASOL.md for upgrading).
    """
    with ex.connect() as c:
        installed = _one(c, "SELECT SCHEMA_COMMENT FROM EXA_SCHEMAS WHERE SCHEMA_NAME = 'PREPROC'")
        if installed is not None or _one(c, "SELECT 1 FROM EXA_SCHEMAS WHERE SCHEMA_NAME = 'PREPROC'"):
            if installed != f"preprocessor-framework {PREPROC_VERSION}":
                print(f"  preprocessor-framework already installed ({installed or 'unknown release'}); "
                      f"pinned {PREPROC_VERSION} not applied: upgrade by hand")
            return
        print(f"  installing preprocessor-framework {PREPROC_VERSION}")
        for stmt in sql_runner.split(fetch(PREPROC_SQL).read_text(encoding="utf-8")):
            c.execute(stmt)
        c.execute(f"COMMENT ON SCHEMA PREPROC IS 'preprocessor-framework {PREPROC_VERSION}'")


def install_semantic_views(ex: Exasol) -> None:
    """exasol-semantic-views, installed by the release's own installer from its prebuilt build/install/.

    The installer is idempotent (catalog tables are created if missing, scripts replaced), so it
    runs whenever the pinned release differs from SEMANTIC_CATALOG.PRODUCT_VERSION. As the
    project's upgrade procedure asks, the system preprocessor is off while the scripts are replaced.
    """
    with ex.connect() as c:
        try:
            have = _one(c, "SELECT DISPLAY_VERSION FROM SEMANTIC_CATALOG.PRODUCT_VERSION")
        except pyexasol.ExaQueryError:
            have = None
    if have and have.lstrip("v") == SEMVIEWS_VERSION.lstrip("v"):
        return
    print(f"  installing exasol-semantic-views {SEMVIEWS_VERSION} (was {have or 'not installed'})")
    with ex.connect() as c:
        system = _one(c, "SELECT SYSTEM_VALUE FROM EXA_PARAMETERS WHERE PARAMETER_NAME = 'SQL_PREPROCESSOR_SCRIPT'")
        if system:
            c.execute("ALTER SYSTEM SET SQL_PREPROCESSOR_SCRIPT = NULL")
    try:
        with tempfile.TemporaryDirectory() as tmp:  # outside the repo, so the installer finds no git checkout
            with zipfile.ZipFile(fetch(SEMVIEWS_ZIP)) as z:
                z.extractall(tmp)
            root = pathlib.Path(tmp) / f"exasol-semantic-views-{SEMVIEWS_VERSION}"
            env = dict(os.environ, EXASOL_HOST=ex.host, EXASOL_PORT="8563", EXASOL_USER=ex.db_user,
                       EXASOL_PASSWORD=ex.db_password, NO_COLOR="1")
            subprocess.run([sys.executable, "-I", "-X", "utf8", str(root / "tools" / "install.py"), "--skip-package"],
                           cwd=root, env=env, check=True)
    finally:
        if system:
            with ex.connect() as c:
                c.execute(f"ALTER SYSTEM SET SQL_PREPROCESSOR_SCRIPT = {system}")


def activate_preprocessor(ex: Exasol, script: str = "PREPROC_RT.MASTER") -> None:
    """Put the framework's dispatcher in the system-wide slot, after proving it in one session."""
    with ex.connect() as c:
        current = _one(c, "SELECT SYSTEM_VALUE FROM EXA_PARAMETERS WHERE PARAMETER_NAME = 'SQL_PREPROCESSOR_SCRIPT'")
        if current and current.upper() == script:
            return
        c.execute(f"ALTER SESSION SET SQL_PREPROCESSOR_SCRIPT = {script}")
        c.execute("SELECT COUNT(*) FROM CREDORA.RUN_LOG").fetchall()  # an ordinary statement through it
        c.execute(f"ALTER SYSTEM SET SQL_PREPROCESSOR_SCRIPT = {script}")
        print(f"  system SQL preprocessor: {current or 'none'} -> {script} "
              f"(roll back: ALTER SYSTEM SET SQL_PREPROCESSOR_SCRIPT = {current or 'NULL'})")


def install_preprocessor_library(ex: Exasol) -> None:
    """exasol-labs/preprocessor-library modules for the roles that send AI-written SQL.

    PREPROC.MODULE_INSTALL is the procedure behind the framework's `PREPROC INSTALL MODULE <name>
    FROM '<source>' FOR ROLE <role>` statement. It is called directly here because deploy sessions
    run with the SQL preprocessor switched off. It fetches the pinned release's index over HTTPS,
    verifies the artifact's sha256, creates the module script and adds the rule for the first role;
    RULE_ENSURE adds the same rule for the other roles (idempotent). Both modules are TRANSLATE
    phase: they run before the semantic layer's EXPAND, so `x::DECIMAL(5,2)` and a trailing comma
    in AI-written SQL reach the semantic compiler as plain Exasol SQL.
    """
    with ex.connect() as c:
        for name, (script, function, sha) in PREPROC_LIB_MODULES.items():
            row = c.execute("SELECT LIBRARY_VERSION, SHA256 FROM PREPROC_RT.INSTALLED_MODULES "
                            "WHERE NAME = {n} AND STATUS = 'deployed'", query_params={"n": name}).fetchone()
            if not row:
                print(f"  installing preprocessor-library {PREPROC_LIB_VERSION} module {name}")
                c.execute("EXECUTE SCRIPT PREPROC.MODULE_INSTALL({src}, {n}, {scope})", query_params={
                    "src": PREPROC_LIB_INDEX, "n": name, "scope": f"ROLE:{AI_SQL_ROLES[0]}"})
                row = c.execute("SELECT LIBRARY_VERSION, SHA256 FROM PREPROC_RT.INSTALLED_MODULES "
                                "WHERE NAME = {n} AND STATUS = 'deployed'", query_params={"n": name}).fetchone()
            if not row or (row[1] or "").lower() != sha:
                raise RuntimeError(f"preprocessor-library module {name}: installed sha256 {row and row[1]} "
                                   f"is not the pinned {sha}")
            for role in AI_SQL_ROLES:
                c.execute("EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', {r}, 'TRANSLATE', {s}, {f}, NULL, TRUE)",
                          query_params={"r": role, "s": script, "f": function})
        c.execute("EXECUTE SCRIPT PREPROC.REFRESH")


CONSUMER_GROUPS = ("CREDORA_BATCH", "CREDORA_APP", "CREDORA_AI")  # limits: exasol/sql/16_resources.sql


def ensure_consumer_groups(ex: Exasol) -> None:
    """Create Credora's consumer groups if missing (Exasol has no CREATE ... IF NOT EXISTS for them)."""
    with ex.connect() as c:
        have = {r[0] for r in c.execute("SELECT CONSUMER_GROUP_NAME FROM EXA_CONSUMER_GROUPS").fetchall()}
        for g in CONSUMER_GROUPS:
            if g not in have:
                c.execute(f"CREATE CONSUMER GROUP {g} WITH CPU_WEIGHT = '100'")
                print(f"  created consumer group {g}")


def refresh_view_lineage(ex: Exasol) -> None:
    """Read every Credora view once (no rows). Exasol marks a view out of date when an object it
    reads is replaced, and EXA_DBA_DEPENDENCIES then shows NULL references for it until the view is
    next compiled; this recompiles them so the lineage is complete right after a deploy."""
    with ex.connect() as c:
        views = c.execute("SELECT VIEW_SCHEMA, VIEW_NAME FROM EXA_ALL_VIEWS "
                          "WHERE VIEW_SCHEMA = 'CREDORA'").fetchall()
        for schema, view in views:
            try:
                c.execute(f'SELECT * FROM "{schema}"."{view}" WHERE FALSE').fetchall()
            except pyexasol.ExaQueryError as e:
                print(f"  view {schema}.{view} does not compile: {e.message}")
