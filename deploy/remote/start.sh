#!/bin/bash
# Runs on the app host. Writes .env.runtime from the deployment's Secrets Manager
# secret, then builds and starts the containers given as arguments (default: all).
set -euo pipefail

cd /opt/credora
SECRET_ID="$(cat deploy/remote/secret_id)"
REGION="$(cat deploy/remote/region)"

aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" \
  --query SecretString --output text \
  | jq -r 'to_entries[] | "\(.key)=\(.value)"' > .env.runtime
echo "AWS_REGION=$REGION" >> .env.runtime
# Exasol's TLS certificate fingerprint (from the launcher, written by deploy/credora.py ship):
# the backend and the Exasol MCP server pin it. Not a secret.
if [ -s deploy/remote/exasol_fingerprint ]; then
  echo "EXASOL_FINGERPRINT=$(cat deploy/remote/exasol_fingerprint)" >> .env.runtime
fi
chmod 600 .env.runtime
cp .env.runtime .env   # docker compose reads .env for ${VAR} substitution

docker compose up -d --build --remove-orphans "$@"
docker compose ps
