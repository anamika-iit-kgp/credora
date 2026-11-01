"""Credora deploy tool: one command builds the whole system in an AWS account.

    python deploy/credora.py deploy  --env credora     # everything, idempotent
    python deploy/credora.py infra   --env credora     # AWS resources and the runtime secret only (OpenTofu)
    python deploy/credora.py ship    --env credora     # app code only (frontend, backend, mocks)
    python deploy/credora.py exasol  --env credora     # Exasol objects only
    python deploy/credora.py status  --env credora
    python deploy/credora.py access  --env credora     # write and show deployments/<env>/ACCESS.md
    python deploy/credora.py allow-ip --env credora [--cidr 1.2.3.4/32]   # let another machine in
    python deploy/credora.py rm-book --env credora     # demo book for the "rm" login (idempotent)
    python deploy/credora.py destroy --env credora

Reads settings from .env.<env> at the repo root (see .env.example and docs/PORTING.md).
Everything a deployment creates locally lives in deployments/<env>/ (gitignored): the Exasol
launcher directory, OpenTofu state, SSH keys, logs and ACCESS.md. Copy that folder and the
.env.<env> file to another machine to operate the same deployment from there.
Needs: AWS CLI (logged in to the target account), Docker (runs OpenTofu), the `exasol`
launcher, ssh/scp, Node.js (builds the frontend). Python deps: deploy/requirements.txt.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

import boto3
import requests
from dotenv import dotenv_values

import creds_bridge
import exasol_setup as es
import sql_runner

ROOT = pathlib.Path(__file__).resolve().parents[1]
INFRA = ROOT / "infra"
DEPLOYMENTS = ROOT / "deployments"
EXASOL_PORTS = (22, 2581, 8443, 8563, 20002, 20003)  # what the launcher's security group opens
TOFU_IMAGE = "ghcr.io/opentofu/opentofu:1.10.6"
EXASOL_SQL = [  # order matters: virtual schemas need data, grants need virtual schemas
    "exasol/sql/01_schemas.sql",
    "exasol/sql/18_pricing_reference.sql",
    "exasol/sql/02_connections.sql",
    "exasol/udf/04_api_udfs.sql",
    "exasol/udf/05_ml_udfs.sql",
    "exasol/udf/09_ai_udf.sql",
    "exasol/lua/06_run_analysis.sql",
    "exasol/lua/08_purge.sql",
]
EXASOL_SQL_AFTER_DATA = ["exasol/sql/03_virtual_schemas.sql", "exasol/sql/07_security.sql",
                         "exasol/sql/13_rm_row_security.sql"]
# Demo seed for the "rm" login's book (idempotent); run after the first published analysis.
RM_BOOK_SQL = "exasol/sql/14_seed_rm_book.sql"
# After the roles and users exist: rules and model grants name the roles.
SEMANTIC_MODULE_SQL = "exasol/extensions/10_semantic_views_module.sql"
SEMANTIC_SQL = ["exasol/semantic/11_latest_run_views.sql", "exasol/semantic/12_credora_model.sql"]
# After the users exist: consumer groups and limits per user, password policy (groups: es.ensure_consumer_groups).
RESOURCES_SQL = "exasol/sql/16_resources.sql"
# The Exasol Scheduler's task and history tables, its jobs and grants (the container is in docker-compose.yml).
SCHEDULER_SQL = "exasol/sql/17_scheduler.sql"
# Last, after every file that creates or replaces scripts: comments are lost when a script is replaced.
COMMENTS_SQL = "exasol/sql/15_comments.sql"


def say(msg: str) -> None:
    print(f"\n== {msg}", flush=True)


def sh(cmd: list[str], **kw) -> None:
    """Run a command, streaming its output through our stdout (and so into the deploy log)."""
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                          encoding="utf-8", errors="replace", **kw) as proc:
        for line in proc.stdout:
            print(line, end="", flush=True)
    if proc.returncode:
        raise subprocess.CalledProcessError(proc.returncode, cmd)


class Tee:
    """Copy everything printed to the console into a log file as well."""

    def __init__(self, stream, path: pathlib.Path):
        if hasattr(stream, "reconfigure"):  # Windows consoles default to a legacy code page
            stream.reconfigure(encoding="utf-8", errors="replace")
        self.stream, self.file = stream, open(path, "a", encoding="utf-8")

    def write(self, data):
        self.stream.write(data)
        # Keep logs portable: no paths of the machine that ran the command.
        for local, short in ((str(ROOT), "."), (str(pathlib.Path.home()), "~")):
            data = data.replace(local, short)
        self.file.write(data)

    def flush(self):
        self.stream.flush()
        self.file.flush()


class Deployment:
    def __init__(self, env: str):
        self.env = env
        env_file = ROOT / f".env.{env}"
        if not env_file.exists():
            sys.exit(f"{env_file} not found. Copy .env.example to .env.{env} and fill it in.")
        self.cfg = {k: v for k, v in dotenv_values(env_file).items() if v not in (None, "")}
        for key in ("AWS_PROFILE", "DOMAIN"):
            if key not in self.cfg:
                sys.exit(f"{key} must be set in {env_file}")
        self.region = self.cfg.get("AWS_REGION", "ap-south-1")
        self.project = self.cfg.get("PROJECT", "credora")
        self.name = f"{self.project}-{env}"
        self.home = DEPLOYMENTS / env           # everything local about this deployment
        self.state = self.home / "tofu"         # OpenTofu state, generated SSH key, AWS configs
        self.exasol_dir = self.home / "exasol"  # the Exasol launcher's deployment directory
        self.logs = self.home / "logs"
        for d in (self.state, self.logs):
            d.mkdir(parents=True, exist_ok=True)
        self._aws_config = self.state / "aws_config_host"
        # A credential_process profile lets long-running tools refresh short `aws login` credentials.
        # It asks deploy/creds_bridge.py, which asks the AWS CLI. (The CLI can't be the
        # credential_process directly: it would read this same config file.)
        self._aws_config.write_text(
            "[default]\n" f"region = {self.region}\n" "credential_process = curl -s http://127.0.0.1:9911/\n")
        (self.state / "aws_config").write_text(
            creds_bridge.CONTAINER_AWS_CONFIG.format(region=self.region, port=9911))

    def exasol_fingerprint(self) -> str:
        """The TLS certificate fingerprint the launcher printed (for SQL clients)."""
        f = self.exasol_dir / "connection-instructions.txt"
        if f.exists():
            for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
                if "Fingerprint:" in line:
                    return line.split("Fingerprint:", 1)[1].strip()
        return "see exasol/connection-instructions.txt"

    def launcher(self, *args: str) -> None:
        sh(["exasol", *args, "--deployment-dir", str(self.exasol_dir), "--auto-approve"], env=self.aws_env())

    @property
    def external_domain(self) -> str:
        return self.cfg.get("EXTERNAL_DOMAIN", "")

    def allowed_cidrs(self) -> list[str]:
        f = self.home / "allowed_ips.txt"
        return [l.strip() for l in f.read_text().splitlines() if l.strip()] if f.exists() else []

    # --- AWS access ------------------------------------------------------------

    def aws_env(self) -> dict:
        env = dict(os.environ, AWS_CONFIG_FILE=str(self._aws_config), AWS_REGION=self.region,
                   AWS_DEFAULT_REGION=self.region, AWS_SDK_LOAD_CONFIG="1")
        env.pop("AWS_PROFILE", None)
        return env

    def boto(self, service: str):
        # Ask the AWS CLI for credentials: it understands every login method, including `aws login`.
        out = subprocess.run(["aws", "configure", "export-credentials", "--profile", self.cfg["AWS_PROFILE"],
                              "--format", "process"], capture_output=True, text=True, check=True,
                             shell=sys.platform == "win32")
        c = json.loads(out.stdout)
        return boto3.client(service, region_name=self.region, aws_access_key_id=c["AccessKeyId"],
                            aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c.get("SessionToken"))

    def admin_cidr(self) -> str:
        if self.cfg.get("ADMIN_CIDR"):
            return self.cfg["ADMIN_CIDR"]
        return requests.get("https://checkip.amazonaws.com", timeout=10).text.strip() + "/32"

    # --- Exasol Personal on AWS (the official launcher) -------------------------

    def exasol_launch(self) -> None:
        say("Exasol Personal on AWS (exasol launcher)")
        if not (self.exasol_dir / "deployment.json").exists():
            if not (self.exasol_dir / "infrastructure").exists():
                sh(["exasol", "init", "aws", "ubuntu", "--deployment-dir", str(self.exasol_dir), "--auto-approve",
                    "--instance-type", self.cfg.get("EXASOL_INSTANCE", "r6i.xlarge")], env=self.aws_env())
            # The aws preset opens every Exasol port to 0.0.0.0/0 by default; restrict it.
            tf = self.exasol_dir / "infrastructure" / "variables_private.tf"
            text = tf.read_text(encoding="utf-8")
            text = text.replace('"0.0.0.0/0" # Warning: Should be restricted in production', f'"{self.admin_cidr()}"')
            tf.write_text(text, encoding="utf-8")
            bridge = creds_bridge.start(self.cfg["AWS_PROFILE"])
            try:
                self.launcher("deploy")
            finally:
                bridge.shutdown()
        self.open_exasol_to(self.allowed_cidrs())
        info = self.exasol_info()
        print(f"   Exasol at {info['public_ip']} (private {info['private_ip']})")

    def exasol_info(self) -> dict:
        d = json.loads((self.exasol_dir / "deployment.json").read_text())
        node = next(iter(d["nodes"].values()))
        secrets = json.loads((self.exasol_dir / "secrets.json").read_text())
        return {"public_ip": node["publicIp"], "private_ip": node["privateIp"], "tag": d["deploymentId"],
                "db_user": secrets["dbUsername"], "db_password": secrets["dbPassword"],
                "ui_user": secrets.get("adminUiUsername", "admin"), "ui_password": secrets.get("adminUiPassword", ""),
                "ui_url": d.get("connection", {}).get("adminUi", {}).get("url", ""),
                "instance": d.get("instanceType", ""), "instance_id": node.get("instanceId", ""),
                "ssh_key": str(self.exasol_dir / "node_access.pem")}

    def exasol(self) -> es.Exasol:
        i = self.exasol_info()
        return es.Exasol(i["public_ip"], i["db_user"], i["db_password"], i["ssh_key"], private_ip=i["private_ip"])

    # --- AWS infrastructure (OpenTofu in Docker) -------------------------------

    def tofu(self, *args: str, capture: bool = False) -> subprocess.CompletedProcess:
        cmd = ["docker", "run", "--rm", "-v", f"{INFRA}:/work", "-v", f"{self.state}:/state", "-w", "/work",
               "-e", "AWS_CONFIG_FILE=/state/aws_config", TOFU_IMAGE, *args]
        env = dict(os.environ, MSYS_NO_PATHCONV="1")
        if capture:
            return subprocess.run(cmd, check=True, text=True, capture_output=True, env=env)
        sh(cmd, env=env)
        return subprocess.CompletedProcess(cmd, 0)

    def infra(self, destroy: bool = False) -> None:
        say("AWS resources: RDS Oracle, MySQL, PostgreSQL, app host, S3, secrets, DNS (OpenTofu)")
        tfvars = {
            "env_name": self.env, "aws_region": self.region, "domain": self.cfg["DOMAIN"],
            "admin_cidr": self.admin_cidr(), "exasol_deployment_tag": self.exasol_info()["tag"],
            "exasol_private_ip": self.exasol_info()["private_ip"], "state_dir": "/state",
            "project": self.project, "external_domain": self.external_domain,
            "extra_admin_cidrs": self.allowed_cidrs(),
        }
        for key, var in (("ORACLE_INSTANCE", "oracle_instance"), ("APP_INSTANCE", "app_instance"),
                         ("AI_PROVIDER", "ai_provider"), ("ANTHROPIC_API_KEY", "anthropic_api_key"),
                         ("AI_MODEL", "ai_model"), ("PUBLIC_DEMO", "public_demo")):
            if key in self.cfg:
                tfvars[var] = self.cfg[key]
        logins = {r: self.cfg[f"APP_{r.upper()}_PASSWORD"] for r in ("admin", "datasci", "loanops", "rm")
                  if f"APP_{r.upper()}_PASSWORD" in self.cfg}
        if len(logins) == 4:
            tfvars["app_passwords"] = logins
        (self.state / "terraform.tfvars.json").write_text(json.dumps(tfvars, indent=2))
        bridge = creds_bridge.start(self.cfg["AWS_PROFILE"])
        try:
            self.tofu("init", "-input=false", "-reconfigure", "-backend-config=path=/state/terraform.tfstate")
            verb = "destroy" if destroy else "apply"
            self.tofu(verb, "-input=false", "-auto-approve", "-var-file=/state/terraform.tfvars.json")
        finally:
            bridge.shutdown()

    def outputs(self) -> dict:
        out = self.tofu("output", "-json", "-state=/state/terraform.tfstate", capture=True).stdout
        return {k: v["value"] for k, v in json.loads(out).items()}

    def secret(self) -> dict:
        sid = self.outputs()["runtime_secret_id"]
        return json.loads(self.boto("secretsmanager").get_secret_value(SecretId=sid)["SecretString"])

    # --- App host ----------------------------------------------------------------

    def ssh(self, command: str, check: bool = True) -> str:
        ip = self.outputs()["app_public_ip"]
        r = subprocess.run(["ssh", "-i", str(self.state / "app_key.pem"), "-o", "StrictHostKeyChecking=accept-new",
                            "-o", "ConnectTimeout=20", f"ubuntu@{ip}", command],
                           capture_output=True, text=True, check=check)
        return r.stdout

    def wait_app_host(self) -> None:
        for _ in range(60):
            try:
                if "done" in self.ssh("test -f /var/lib/credora-bootstrap-done && echo done", check=False):
                    return
            except subprocess.SubprocessError:
                pass
            time.sleep(10)
        sys.exit("app host never finished bootstrapping")

    def build_frontend(self) -> None:
        say("Frontend build")
        npm = shutil.which("npm") or "npm"
        sh([npm, "ci", "--no-audit", "--no-fund"], cwd=ROOT / "frontend")
        sh([npm, "run", "build"], cwd=ROOT / "frontend")

    def build_sites(self) -> None:
        if (ROOT / "sites" / "build_docs.py").exists():
            say("Docs site")
            sh([sys.executable, str(ROOT / "sites" / "build_docs.py")], cwd=ROOT)

    def caddyfile(self) -> str:
        """Caddy config for this deployment, for the bank's domain and, if set, the 3rd party data APIs domain."""
        d, x = self.cfg["DOMAIN"], self.external_domain

        def static(root: str) -> str:
            return f"\t\troot * {root}\n\t\ttry_files {{path}} /index.html\n\t\tfile_server\n"

        def relay(host: str, upstream: str) -> str:
            # A relay's root has no page of its own: send visitors to its API reference (/docs).
            return (f"{host} {{\n\theader /status Access-Control-Allow-Origin \"https://{x}\"\n"
                    f"\tredir / /docs 302\n\treverse_proxy {upstream}\n}}\n")

        assets = "\thandle /_assets/* {\n\t\troot * /sites\n\t\tfile_server\n\t}\n"  # shared CSS, fonts, logos
        # /demo.mp4 serves a full quality demo-hq.mp4 when one is present (kept out of the repository).
        media = assets + ("\t@hq path /demo.mp4\n\thandle @hq {\n\t\troot * /media\n\t\ttry_files /demo-hq.mp4 /demo.mp4\n\t\tfile_server\n\t}\n"
                          "\t@media path /video.json /presentation.pdf /presentation.pptx /demo.vtt /demo.srt /demo-transcript.md\n"
                          "\thandle @media {\n\t\troot * /media\n\t\theader /demo.vtt Content-Type \"text/vtt; charset=utf-8\"\n\t\tfile_server\n\t}\n")
        # Page-view counters for the docs, video and presentation sites (counts only, nothing per visitor).
        views = "\thandle /api/views* {\n\t\treverse_proxy backend:8000\n\t}\n"
        mocks = "" if x else (
            "\thandle_path /mock/cibil/* {\n\t\treverse_proxy cibil:8101\n\t}\n"
            "\thandle_path /mock/gstn/* {\n\t\treverse_proxy gstn:8102\n\t}\n"
            "\thandle_path /mock/aa/* {\n\t\treverse_proxy aa:8103\n\t}\n")
        blocks = [
            f"{d} {{\n\tencode zstd gzip\n\thandle /api/* {{\n\t\treverse_proxy backend:8000\n\t}}\n{mocks}"
            f"\thandle {{\n{static('/srv')}\t}}\n"
            "\theader {\n\t\tStrict-Transport-Security \"max-age=31536000\"\n\t\tX-Content-Type-Options nosniff\n"
            "\t\tReferrer-Policy strict-origin-when-cross-origin\n\t}\n}\n",
            f"www.{d} {{\n\tredir https://{d}{{uri}} permanent\n}}\n",
            f"docs.{d} {{\n\tencode zstd gzip\n{views}\thandle {{\n{static('/sites/docs/dist')}\t}}\n}}\n",
            f"video.{d} {{\n{views}{media}\thandle {{\n{static('/sites/video')}\t}}\n}}\n",
            f"ppt.{d} {{\n{views}{media}\thandle {{\n{static('/sites/ppt')}\t}}\n}}\n",
        ]
        if x:
            blocks += [
                f"{x} {{\n\tencode zstd gzip\n{assets}\thandle {{\n{static('/sites/external')}\t}}\n}}\n",
                f"www.{x} {{\n\tredir https://{x}{{uri}} permanent\n}}\n",
                # /status (public counts) may be read by the 3rd party data APIs landing page.
                relay(f"cibil.{x}", "cibil:8101"),
                relay(f"gst.{x}", "gstn:8102"),
                relay(f"aa.{x}", "aa:8103"),
            ]
        return "\n".join(blocks)

    def ship(self) -> None:
        self.build_frontend()
        self.build_sites()
        say("Ship code to the app host and start containers")
        self.wait_app_host()
        out = self.outputs()
        files = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=ROOT,
                               capture_output=True, text=True, check=True).stdout.split("\n")
        skip = ("deploy/.venv/", "deploy/.cache/", "infra/state/", "deployments/", "frontend/node_modules/")
        with tempfile.TemporaryDirectory() as tmp:
            tgz = pathlib.Path(tmp) / "credora.tgz"
            with tarfile.open(tgz, "w:gz") as t:
                for f in files:
                    if f and not f.startswith(skip) and (ROOT / f).is_file():
                        t.add(ROOT / f, arcname=f)
                t.add(ROOT / "frontend" / "dist", arcname="frontend/dist")
                if (ROOT / "sites" / "docs" / "dist").exists():
                    t.add(ROOT / "sites" / "docs" / "dist", arcname="sites/docs/dist")
                if (ROOT / "media").exists():
                    t.add(ROOT / "media", arcname="media")
                cfg_js = pathlib.Path(tmp) / "config.js"
                cfg_js.write_text(f'window.CREDORA_BANK_URL = "https://{self.cfg["DOMAIN"]}";\n')
                t.add(cfg_js, arcname="sites/external/config.js")
                # exasol_fingerprint: Exasol's TLS certificate fingerprint, pinned by the backend and the
                # MCP server (start.sh adds it to .env.runtime as EXASOL_FINGERPRINT).
                fp = self.exasol_fingerprint()
                for name, value in (("secret_id", out["runtime_secret_id"]), ("region", self.region),
                                    ("Caddyfile", self.caddyfile()),
                                    ("exasol_fingerprint", fp if fp.isalnum() else "")):
                    p = pathlib.Path(tmp) / name
                    p.write_text(value)
                    t.add(p, arcname=f"deploy/remote/{name}")
            sh(["scp", "-i", str(self.state / "app_key.pem"), "-q", str(tgz), f"ubuntu@{out['app_public_ip']}:/tmp/"])
        print(self.ssh("cd /opt/credora && tar -xzf /tmp/credora.tgz && mkdir -p media sites && "
                       "bash deploy/remote/start.sh 2>&1 | tail -12 && docker compose restart caddy >/dev/null 2>&1"))

    # --- Data and Exasol objects ------------------------------------------------------

    def generate(self, seed: int | None = 2026) -> None:
        say("Generate mock data (1,000 companies)")
        body = json.dumps({"seed": seed})
        job = json.loads(self.ssh(f"curl -s -X POST localhost:8100/generate -H 'content-type: application/json' -d '{body}'"))
        while True:
            st = json.loads(self.ssh(f"curl -s localhost:8100/jobs/{job['job_id']}"))
            if st["status"] != "running":
                break
            time.sleep(10)
        if st["status"] != "done":
            sys.exit(f"generation failed: {st.get('error')}")
        print("   " + ", ".join(f"{k} {v:,}" for k, v in st["counts"].items()))

    def exasol_objects(self) -> None:
        say("Exasol extensions: Rust SLC, adbc-vs-rs, Oracle virtual schema, JDBC driver")
        ex = self.exasol()
        es.install_rust_slc(ex)
        es.install_adbc_vs(ex)
        es.install_oracle_vs(ex)
        say("Exasol objects: schemas, connections, UDFs, scripts, virtual schemas, roles")
        values = dict(self.secret(), APP_PRIVATE_IP=self.outputs()["app_private_ip"],
                      EXASOL_PRIVATE_IP=ex.private_ip, BUCKETFS_WRITE_PASSWORD=ex.bfs_password)
        values.update(self.mock_urls(values["APP_PRIVATE_IP"]))
        es.create_roles(ex)
        with ex.connect() as c:
            for f in EXASOL_SQL:
                print(f"   {f}")
                sql_runner.run_file(c, ROOT / f, values, quiet=True)
            if values.get("ANTHROPIC_API_KEY"):
                c.execute(f"CREATE OR REPLACE CONNECTION AI_LLM TO 'https://api.anthropic.com' "
                          f"USER 'anthropic' IDENTIFIED BY '{values['ANTHROPIC_API_KEY']}'")
                c.execute("GRANT ACCESS ON CONNECTION AI_LLM TO R_SVC")
            for f in EXASOL_SQL_AFTER_DATA:
                print(f"   {f}")
                sql_runner.run_file(c, ROOT / f, values, quiet=True)
        es.create_users(ex, values)
        es.ensure_consumer_groups(ex)
        with ex.connect() as c:
            for f in (RESOURCES_SQL, SCHEDULER_SQL):
                print(f"   {f}")
                sql_runner.run_file(c, ROOT / f, quiet=True)
        self.semantic_layer(ex)

    def mock_urls(self, app_private_ip: str) -> dict:
        """Where Exasol's UDFs fetch 3rd party data via API. That is the HTTPS relays when there is a
        3rd party data APIs domain, else the app host's private address."""
        x = self.external_domain
        if x:
            return {"MOCK_CIBIL_URL": f"https://cibil.{x}", "MOCK_GSTN_URL": f"https://gst.{x}",
                    "MOCK_AA_URL": f"https://aa.{x}"}
        return {"MOCK_CIBIL_URL": f"http://{app_private_ip}:8101", "MOCK_GSTN_URL": f"http://{app_private_ip}:8102",
                "MOCK_AA_URL": f"http://{app_private_ip}:8103"}

    def semantic_layer(self, ex: es.Exasol) -> None:
        say(f"SQL preprocessing: preprocessor-framework {es.PREPROC_VERSION}, "
            f"exasol-semantic-views {es.SEMVIEWS_VERSION}, the Credora semantic model")
        es.install_preprocessor_framework(ex)
        es.install_semantic_views(ex)
        with ex.connect() as c:
            print(f"   {SEMANTIC_MODULE_SQL}")
            sql_runner.run_file(c, ROOT / SEMANTIC_MODULE_SQL, {"SEMVIEWS_VERSION": es.SEMVIEWS_VERSION}, quiet=True)
            # The model is code: rebuild it from the files every time.
            if c.execute("SELECT 1 FROM SEMANTIC_CATALOG.MODELS WHERE MODEL_NAME = 'credora'").fetchall():
                c.execute("EXECUTE SCRIPT SEMANTIC_ADMIN.DROP_MODEL('credora')")
            for f in SEMANTIC_SQL:
                print(f"   {f}")
                sql_runner.run_file(c, ROOT / f, quiet=True)
            issues = c.execute("EXECUTE SCRIPT SEMANTIC_ADMIN.VALIDATE_MODEL('credora')").fetchall()
            for issue in issues:
                print(f"   validation: {issue}")
            if any(i[0] == "ERROR" for i in issues):
                sys.exit("the semantic model does not validate")
        es.activate_preprocessor(ex)
        say(f"preprocessor-library {es.PREPROC_LIB_VERSION}: {', '.join(es.PREPROC_LIB_MODULES)} "
            f"for the roles that send AI-written SQL")
        es.install_preprocessor_library(ex)
        say("Comments on every Credora object; view lineage")
        with ex.connect() as c:
            print(f"   {COMMENTS_SQL}")
            sql_runner.run_file(c, ROOT / COMMENTS_SQL, quiet=True)
        es.refresh_view_lineage(ex)

    def first_analysis(self) -> None:
        say("First analysis through the web app's API, published to loan operations")
        s = self.secret()
        base = "http://localhost:8000/api"
        # The data scientist runs the analysis and publishes it; nobody else may.
        login = json.dumps({"username": "datasci", "password": s["APP_DATASCI_PASSWORD"]})
        token = json.loads(self.ssh(
            f"curl -s -X POST {base}/auth/login -H 'content-type: application/json' -d '{login}'"))["token"]
        auth = f"-H 'authorization: Bearer {token}'"
        job = json.loads(self.ssh(f"curl -s -X POST {base}/analysis/run {auth}"))
        while True:
            st = json.loads(self.ssh(f"curl -s {base}/jobs/{job['job_id']} {auth}"))
            if st["status"] != "running":
                break
            time.sleep(5)
        print(f"   analysis {st['status']}")
        if st["status"] == "done":
            note = json.dumps({"note": "First analysis of this deployment"})
            self.ssh(f"curl -s -X POST {base}/runs/{st['run_id']}/publish {auth} "
                     f"-H 'content-type: application/json' -d '{note}'")
            print(f"   published {st['run_id']}")
            self.rm_book()

    def rm_book(self) -> None:
        """Demo seed: 25 companies of the latest published run for the "rm" login (RM001). Idempotent."""
        say("Demo book for relationship manager RM001 (CREDORA_RM)")
        with self.exasol().connect() as c:
            sql_runner.run_file(c, ROOT / RM_BOOK_SQL, quiet=True)
            n = c.execute("SELECT COUNT(*) FROM CREDORA.RM_ASSIGNMENT WHERE RM_ID = 'RM001'").fetchval()
        print(f"   RM001 has {n} assigned companies")

    # --- access from more machines ------------------------------------------------------

    def open_exasol_to(self, cidrs: list[str]) -> None:
        """Add IP ranges to the Exasol launcher's security group (the launcher opens it to one CIDR)."""
        if not cidrs:
            return
        ec2 = self.boto("ec2")
        tag = self.exasol_info()["tag"]
        groups = ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [f"{tag}-sg"]}])["SecurityGroups"]
        if not groups:
            print(f"   no security group {tag}-sg found")
            return
        sg = groups[0]
        have = {(r.get("FromPort"), ip["CidrIp"]) for r in sg["IpPermissions"] for ip in r.get("IpRanges", [])}
        perms = [{"IpProtocol": "tcp", "FromPort": port, "ToPort": port,
                  "IpRanges": [{"CidrIp": c, "Description": "added by credora.py allow-ip"}]}
                 for port in EXASOL_PORTS for c in cidrs if (port, c) not in have]
        if perms:
            ec2.authorize_security_group_ingress(GroupId=sg["GroupId"], IpPermissions=perms)
            print(f"   Exasol now open to {', '.join(cidrs)} on ports {', '.join(map(str, EXASOL_PORTS))}")

    def allow_ip(self, cidr: str | None) -> None:
        """Let another machine (e.g. a second laptop) reach Exasol and SSH, then record it."""
        cidr = cidr or requests.get("https://checkip.amazonaws.com", timeout=10).text.strip() + "/32"
        if "/" not in cidr:
            cidr += "/32"
        say(f"Allow {cidr}")
        cidrs = sorted(set(self.allowed_cidrs()) | {cidr})
        (self.home / "allowed_ips.txt").write_text("\n".join(cidrs) + "\n")
        self.open_exasol_to([cidr])
        ec2 = self.boto("ec2")
        sg = self.outputs()["app_security_group_id"]
        try:
            ec2.authorize_security_group_ingress(GroupId=sg, IpPermissions=[{
                "IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
                "IpRanges": [{"CidrIp": cidr, "Description": "SSH for the deployer"}]}])
            print(f"   app host SSH now open to {cidr}")
        except ec2.exceptions.ClientError as e:
            if "Duplicate" not in str(e):
                raise
        print("   recorded in deployments/{}/allowed_ips.txt (kept on every redeploy)".format(self.env))
        self.access()

    def access(self) -> None:
        """Write deployments/<env>/ACCESS.md: every address, login and command for this deployment."""
        out, s, x = self.outputs(), self.secret(), self.exasol_info()
        e = self.env
        app_ip, exa_ip = out["app_public_ip"], x["public_ip"]
        ext = self.external_domain
        lines = [
            f"# Credora deployment `{e}`",
            "",
            "Generated by `python deploy/credora.py access --env {}`. Keep this folder private: it holds".format(e),
            "passwords and SSH keys. Paths below are relative to the repo root.",
            "",
            "## Web",
            "",
            "| What | Address |",
            "|---|---|",
            f"| Web app | {out['site_url']} |",
            f"| Docs | https://docs.{self.cfg['DOMAIN']} |",
            f"| Demo video | https://video.{self.cfg['DOMAIN']} |",
            f"| Presentation | https://ppt.{self.cfg['DOMAIN']} |",
        ]
        if ext:
            lines += [f"| 3rd party data APIs | https://{ext} |",
                      f"| Mock CIBIL relay | https://cibil.{ext}/docs |",
                      f"| Mock GSTN relay | https://gst.{ext}/docs |",
                      f"| Mock Account Aggregator relay | https://aa.{ext}/docs |"]
        lines += [
            "",
            "Web logins: " + ", ".join(f"`{u}` / `{s[f'APP_{u.upper()}_PASSWORD']}`"
                                        for u in ("admin", "datasci", "loanops", "rm")),
            f"Mock API key (header `X-API-Key`): `{s['MOCK_API_TOKEN']}`",
            "",
            "## Exasol",
            "",
            "| What | Value |",
            "|---|---|",
            f"| Host | `{exa_ip}` (private `{x['private_ip']}`), instance `{x['instance']}` `{x['instance_id']}` |",
            f"| SQL | `{exa_ip}:8563`, user `{x['db_user']}`, password `{x['db_password']}` (TLS, self-signed) |",
            f"| Certificate fingerprint | `{self.exasol_fingerprint()}` (paste into DbVisualizer/DBeaver, or `{exa_ip}/<fingerprint>:8563`) |",
            f"| Admin UI | {x['ui_url']} user `{x['ui_user']}` password `{x['ui_password']}` |",
            "| BucketFS | `https://{}:2581/default`, write user `w`, password: `python deploy/credora.py access` reads it from the node |".format(exa_ip),
            f"| SSH | `ssh -i deployments/{e}/exasol/node_access.pem ubuntu@{exa_ip}` |",
            f"| Launcher | `exasol status --deployment-dir deployments/{e}/exasol` |",
            "",
            "Role users. The web app logs in as these, Ask Credora as the _AI users, and MCP clients outside "
            "the app as CREDORA_MCP.",
            "",
        ]
        for u, (_, k) in es.ROLE_USERS.items():
            lines.append(f"- `{u}` / `{s.get(k, '')}`")
        lines += [
            "",
            "Connect from Python, pinning the certificate: `pyexasol.connect(dsn='{}/{}:8563', user='{}', "
            "password='...')`".format(exa_ip, self.exasol_fingerprint(), x["db_user"]),
            "",
            "Exasol MCP server for an AI client (read-only user):",
            "",
            "```json",
            json.dumps({"exasol-credora": {"command": "uvx", "args": ["exasol-mcp-server@2.3.0"], "env": {
                "EXA_DSN": f"{exa_ip}:8563", "EXA_USER": "CREDORA_MCP", "EXA_PASSWORD": s.get("EXA_MCP_PASSWORD", ""),
                "EXA_SSL_CERT_VALIDATION": "no"}}}, indent=2),
            "```",
            "",
            "## App host",
            "",
            f"- SSH: `ssh -i deployments/{e}/tofu/app_key.pem ubuntu@{app_ip}` (code in `/opt/credora`, `docker compose ps`)",
            f"- Private IP `{out['app_private_ip']}`; runtime secret `{out['runtime_secret_id']}` in Secrets Manager",
            "",
            "## Sapphire Bank databases (RDS, reachable only inside the VPC: SSH to the app host first)",
            "",
            "| Database | Endpoint | Admin user / password | Read-only user / password |",
            "|---|---|---|---|",
            f"| Oracle `SAPPHIRE` (schema CBS) | `{s['ORACLE_HOST']}:{s['ORACLE_PORT']}` | `{s['ORACLE_USER']}` / `{s['ORACLE_PASSWORD']}` | `CREDORA_RO` / `{s['ORACLE_RO_PASSWORD']}` |",
            f"| MySQL `cif` | `{s['MYSQL_HOST']}:{s['MYSQL_PORT']}` | `{s['MYSQL_USER']}` / `{s['MYSQL_PASSWORD']}` | `credora_ro` / `{s['MYSQL_RO_PASSWORD']}` |",
            f"| PostgreSQL `los`, `crm` | `{s['PG_HOST']}:{s['PG_PORT']}` | `{s['PG_USER']}` / `{s['PG_PASSWORD']}` | `credora_ro` / `{s['PG_RO_PASSWORD']}` |",
            "",
            f"Tunnel example: `ssh -i deployments/{e}/tofu/app_key.pem -N -L 15432:{s['PG_HOST']}:5432 ubuntu@{app_ip}`",
            "",
            "## AWS",
            "",
            f"- Profile `{self.cfg['AWS_PROFILE']}`, region `{self.region}`, S3 bucket `{out['s3_bucket']}`",
            f"- Allowed admin IPs: {', '.join(['`' + self.admin_cidr() + '`'] + ['`' + c + '`' for c in self.allowed_cidrs()])}",
            "",
            "## Working from another machine",
            "",
            f"1. Clone the repo and copy this folder (`deployments/{e}/`) and `.env.{e}` into it.",
            "2. Install: AWS CLI, Docker, Node.js, Python 3.12 with `make setup` (or `uv venv deploy/.venv` + requirements), and the `exasol` launcher.",
            f"3. `aws login --profile {self.cfg['AWS_PROFILE']}`",
            f"4. `python deploy/credora.py allow-ip --env {e}` opens Exasol and SSH to the new machine's IP.",
            f"5. `python deploy/credora.py status --env {e}`; any other command works from there too.",
            "",
            "Logs of every command run are in `deployments/{}/logs/`.".format(e),
        ]
        path = self.home / "ACCESS.md"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        say(f"Access details written to deployments/{e}/ACCESS.md")

    # --- commands -----------------------------------------------------------------

    def deploy(self) -> None:
        self.exasol_launch()
        self.infra()
        self.ship()
        self.generate()
        self.exasol_objects()
        self.first_analysis()
        self.status()
        self.access()

    def status(self) -> None:
        say("Status")
        out = self.outputs()
        s = self.secret()
        print(f"   Site:     {out['site_url']}")
        if out.get("external_url"):
            print(f"   3rd party APIs: {out['external_url']}  (relays cibil., gst., aa.{self.external_domain})")
        print(f"   Logins:   admin / {s['APP_ADMIN_PASSWORD']}, datasci / {s['APP_DATASCI_PASSWORD']}, "
              f"loanops / {s['APP_LOANOPS_PASSWORD']}, rm / {s['APP_RM_PASSWORD']}")
        print(f"   Exasol:   {self.exasol_info()['public_ip']}:8563 (your IP only)")
        print(self.ssh("cd /opt/credora && docker compose ps --format '   {{.Service}}: {{.Status}}'", check=False))

    def destroy(self) -> None:
        say(f"Destroy deployment {self.env}")
        self.infra(destroy=True)
        bridge = creds_bridge.start(self.cfg["AWS_PROFILE"])
        try:
            self.launcher("destroy")
        finally:
            bridge.shutdown()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["deploy", "infra", "ship", "exasol", "generate", "status", "access",
                                        "allow-ip", "rm-book", "destroy"])
    ap.add_argument("--env", required=True, help="deployment name; reads .env.<name>")
    ap.add_argument("--cidr", help="allow-ip: the IP range to allow (default: this machine's public IP)")
    a = ap.parse_args()
    d = Deployment(a.env)
    # Every run is logged in full (launcher output, URLs, fingerprints, IPs) under deployments/<env>/logs/.
    log = d.logs / f"{time.strftime('%Y%m%d-%H%M%S')}-{a.command}.log"
    sys.stdout, sys.stderr = Tee(sys.stdout, log), Tee(sys.stderr, log)
    print(f"log: deployments/{a.env}/logs/{log.name}")
    commands = {"deploy": d.deploy, "infra": d.infra, "ship": d.ship, "exasol": d.exasol_objects,
                "generate": d.generate, "status": d.status, "access": d.access, "destroy": d.destroy,
                "rm-book": d.rm_book, "allow-ip": lambda: d.allow_ip(a.cidr)}
    commands[a.command]()


if __name__ == "__main__":
    main()
