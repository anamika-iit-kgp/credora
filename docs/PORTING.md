# Moving Credora to another AWS account or domain

Credora is built so it can be deployed to any AWS account and any domain without changing code. Everything that belongs to one particular deployment lives in an env file, never in the repo.

| Deployment | AWS account | Domain | Env file |
|---|---|---|---|
| Prod | Anamika's own account | `credora.loan`, 3rd party data APIs `credora.link` | `.env.credora` |

## The rules the code follows

1. **Nothing account-specific in code.** No account IDs, hosted zone IDs, ARNs, IP addresses, bucket names or domain names are written into the code.
2. **Everything comes from the env file or is looked up at deploy time.**
   - the account ID comes from `aws sts get-caller-identity`
   - the hosted zone ID comes from `DOMAIN`, using `route53 list-hosted-zones-by-name`
   - the Exasol and bank-apps IP addresses come from the infrastructure outputs
   - the S3 bucket is named `${PROJECT}-${ACCOUNT_ID}-${AWS_REGION}-${env_name}` (`infra/main.tf`), which is unique in every account and per deployment
   - Exasol's TLS certificate fingerprint comes from the launcher's `deployments/<env name>/exasol/connection-instructions.txt`, and `ship` passes it to the app host, where the backend and the MCP server pin it
3. **The domain appears in one place only, `DOMAIN`.** Caddy, the Route 53 records, the web app and the API all read it from there.
4. **Secrets are created fresh in each account.** `make deploy` generates or reads them from the env file and stores them in that account's Secrets Manager.
5. **Infrastructure state is kept per deployment**, under `deployments/<env name>/` (OpenTofu state in `tofu/`, the Exasol launcher's directory in `exasol/`). Each deployment has its own state, and that folder is never committed.
6. **Data is regenerated, not migrated.** All data is synthetic. A new deployment runs the mock data generator and retrains the ML model, so there is nothing to copy between accounts.

## How to move

1. Make sure the new account has a Route 53 hosted zone for the new domain (for example `credora.link`).
2. Log the AWS CLI in to the new account, for example `aws login --profile credora`.
3. Copy `.env.example` to `.env.credora` and fill it in.
   ```
   AWS_PROFILE=credora
   DOMAIN=credora.loan
   EXTERNAL_DOMAIN=credora.link
   ```
   Also fill in the passwords and your IP.
4. Deploy with `make deploy ENV=credora`.
5. Check with `make status ENV=credora`, then open `https://credora.loan`.
6. Remove an old deployment with `make destroy ENV=<old name>`.

The two deployments are completely separate, so the old one can keep running until the new one is checked.

The `make` targets wrap the deploy tool, which can also be run directly.

| Command | Does |
|---|---|
| `python deploy/credora.py deploy --env <name>` | Everything, idempotent. Exasol via the launcher, AWS infrastructure, app host, data, Exasol objects, first analysis |
| `python deploy/credora.py infra --env <name>` | The AWS resources and the runtime secret only (OpenTofu) |
| `python deploy/credora.py ship --env <name>` | Rebuilds and restarts the app host only |
| `python deploy/credora.py exasol --env <name>` | Re-applies the Exasol objects, meaning containers, adapters, connections, UDFs, Lua, roles and users, preprocessor framework, semantic model |
| `python deploy/credora.py generate --env <name>` | Regenerates the synthetic data |
| `python deploy/credora.py status --env <name>` | Site address, logins, container health |
| `python deploy/credora.py access --env <name>` | Writes `deployments/<name>/ACCESS.md` |
| `python deploy/credora.py allow-ip --env <name>` | Opens Exasol and SSH to this machine's IP |
| `python deploy/credora.py destroy --env <name>` | Removes everything the deployment created |

The role users that the web app logs in as (`CREDORA_ADMIN`, `CREDORA_DATASCI`, `CREDORA_LOANOPS`, `CREDORA_RM` and the second manager `CREDORA_RM002`), the AI users that Ask Credora logs in as (`CREDORA_ADMIN_AI`, `CREDORA_DATASCI_AI`, `CREDORA_LOANOPS_AI`, `CREDORA_RM_AI`), plus `CREDORA_SVC` and `CREDORA_MCP`, are created by `exasol` with passwords from that account's Secrets Manager, so access control moves with the deployment unchanged.

## Everything about a deployment is in one folder

`deploy/credora.py` keeps all local state of a deployment in `deployments/<env>/` (gitignored).

| Path | What |
|---|---|
| `exasol/` | The Exasol launcher's deployment directory, with `secrets.json` (database and Admin UI passwords), `node_access.pem` (SSH key), `deployment.json`, its OpenTofu state |
| `tofu/` | Credora's OpenTofu state, the app host's SSH key `app_key.pem`, generated variables |
| `logs/` | The full output of every command run, including the launcher's connection details |
| `ACCESS.md` | Every URL, login, password, endpoint and connection command, written by `credora.py access` |
| `allowed_ips.txt` | Extra IP ranges allowed to reach Exasol and SSH (`credora.py allow-ip`) |

To operate the same deployment from another laptop, clone the repo, copy `deployments/<env>/` and `.env.<env>` into it, log the AWS CLI in, and run `python deploy/credora.py allow-ip --env <env>` to open Exasol and SSH to the new machine's IP. Keep the folder private, because it holds passwords and keys.
