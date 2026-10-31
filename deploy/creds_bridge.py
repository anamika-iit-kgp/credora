"""Serve short-lived AWS credentials from the host CLI profile to containers.

`aws login` credentials last about 15 minutes and refresh only through the
host AWS CLI. Long OpenTofu runs (RDS takes 20+ minutes) run in a container,
so the container's AWS config points `credential_process` at this server,
which asks the host CLI for fresh credentials on every call.

Listens on 127.0.0.1 only; Docker Desktop forwards host.docker.internal there.
"""

import http.server
import subprocess
import sys
import threading


def _handler(profile: str):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            out = subprocess.run(
                ["aws", "configure", "export-credentials", "--profile", profile, "--format", "process"],
                capture_output=True, text=True, shell=sys.platform == "win32",
            )
            body = out.stdout.encode() if out.returncode == 0 else b""
            self.send_response(200 if body else 500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    return Handler


class _Existing:
    """Stand-in when a bridge already serves the port (e.g. one started by hand)."""

    def shutdown(self):
        pass


def start(profile: str, port: int = 9911):
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), _handler(profile))
    except OSError:
        return _Existing()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


CONTAINER_AWS_CONFIG = """[default]
region = {region}
credential_process = sh -c "wget -qO- http://host.docker.internal:{port}/"
"""


if __name__ == "__main__":
    srv = start(sys.argv[1] if len(sys.argv) > 1 else "default")
    print(f"serving credentials on 127.0.0.1:{srv.server_port}", flush=True)
    threading.Event().wait()
