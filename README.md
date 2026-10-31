# Credora

[![CI](https://github.com/anamika-iit-kgp/credora/actions/workflows/ci.yml/badge.svg)](https://github.com/anamika-iit-kgp/credora/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Exasol Personal 2026.1](https://img.shields.io/badge/Exasol%20Personal-2026.1-1ba0e2.svg)](https://github.com/exasol/exasol-personal)
[![ExaThon India 2026](https://img.shields.io/badge/ExaThon-India%202026-0b3d91.svg)](https://credora.loan)

Credora helps a bank lend to its own business customers before they ask. For every corporate customer of Sapphire Bank it decides whether to make a pre-approved loan offer, sets the amount, rate and tenure, and sets how far the relationship manager may negotiate. All of the analysis runs inside Exasol Personal, where the bank's data already meets.

It is live and working. Every link below is the real deployment.

| Site | Link |
|---|---|
| Live app | https://credora.loan |
| Docs | https://docs.credora.loan |
| Presentation | https://ppt.credora.loan |
| Demo video | https://video.credora.loan |
| 3rd party data, fetched on demand via API (mock CIBIL, GSTN and Account Aggregator APIs) | https://credora.link |
| Source code | https://github.com/anamika-iit-kgp/credora |

Sign in with one click on the login page, or use a demo login. All data is synthetic, so the passwords are public.

- `admin` / `Demo@123` is the bank manager, who approves models and policy.
- `datasci` / `Demo@123` is the data scientist, who runs the analysis and publishes it.
- `loanops` / `Demo@123` is loan operations, who assigns companies to relationship managers.
- `rm` / `Demo@123` is Subhashree Mohanty (`RM001`), a relationship manager who sees only her own companies.

## Submission at a glance

| ExaThon asks for | Where it is |
|---|---|
| A clear problem statement | [The problem](#the-problem) |
| A working solution using Exasol Personal | [The solution](#the-solution), live at https://credora.loan, and [Exasol features used](#exasol-features-used) |
| A public code repository | https://github.com/anamika-iit-kgp/credora (MIT licence) |
| Setup and reproduction instructions | [Setup and reproduction](#setup-and-reproduction) |
| Data sources, licences, APIs and third-party tools | [Data sources, licences, APIs and third-party tools](#data-sources-licences-apis-and-third-party-tools) |
| Demonstration video and supporting materials | [Demo video and supporting materials](#demo-video-and-supporting-materials) |

![Big picture of Credora. Three bank databases and 3rd party data via API meet in Exasol, and four roles and Ask Credora read the result](docs/img/01-big-picture.png)

## The problem

Banks already hold most of what they need to lend to their existing business customers. Transactions sit in core banking, partner and KYC details in the customer master, and each company's credit need on file in loan origination. Credit bureau, GST and Account Aggregator data can be fetched by API, with the customer's consent.

The trouble is that this data lives in separate systems. A credit team has to gather it by hand, score the risk and price each offer one customer at a time, so good customers wait weeks and some are never approached. Copying everything into yet another system adds cost, delay and data-protection risk.

Credora answers one question for every corporate customer, in one run. Should the bank offer this company a loan, how much, at what rate and for how long, and how far can the relationship manager negotiate? It answers it where the data already is, and each person sees only what their role allows.

## The solution

Sapphire Bank has a large book of corporate current-account customers and wants to approach the best of them with a pre-approved offer. Each offer has an amount, a rate and a tenure, plus a negotiation limit the relationship manager can move within. The data for that sits in the bank's Oracle, MySQL and PostgreSQL databases (including each company's credit need on file) and in 3rd party data via API from CIBIL, GSTN and the Account Aggregator. One call, `EXECUTE SCRIPT CREDORA.RUN_ANALYSIS('<run>')`, reads all six sources in place, scores risk with models trained in Exasol and prices and ranks the companies analysed in about 18 seconds.

Credora does all of this inside Exasol Personal, where the data already meets, so the bank can approach its best customers first with a ready offer. The data scientist runs the analysis and publishes it. Loan operations assigns the companies to relationship managers, and each manager negotiates inside the limit and logs the loan status. The admin approves model activations and policy changes. In every role, Ask Credora answers plain-English questions with Claude through the official Exasol MCP server.

![Analysis flow. RUN_ANALYSIS reads the bank databases and 3rd party data, builds features, scores, flags anomalies, prices, ranks and hands over](docs/img/04-analysis-flow.png)

## Exasol features used

Credora started on the Exasol Personal Local Starter Kit (`exakit` 0.2.3, with the Exasol MCP server 2.3.0, `exapump` 0.13.1 and `pyexasol`). It was then deployed on AWS with the Exasol Personal launcher 2.3.0, running Exasol 2026.1.0 on an `r6i.xlarge`.

| Exasol feature | Where Credora uses it |
|---|---|
| Virtual schemas | `VS_CBS` (Oracle adapter 6.0, Java), `VS_CIF` and `VS_LOS` (adbc-vs-rs 0.7, Rust) read the three bank databases live, with pushdown. Nothing is copied. |
| `EXPLAIN VIRTUAL` | The Sources screen shows the SQL Exasol sends to each database. The aggregation over 850,000 transactions runs inside Oracle. |
| Script language containers | Built-in Python 3 and Java, plus a custom Rust container (0.23.1) uploaded to BucketFS |
| BucketFS | The Rust container, the adapter library, JDBC drivers and every trained model |
| Python UDFs (SET and SCALAR) | Fetch CIBIL, GST and Account Aggregator data in parallel, train and score the risk models, and write credit memos with Claude |
| CONNECTION objects | API endpoints and keys, the BucketFS location and the AI provider, so no secret is in code |
| In-database ML | A gradient-boosting champion, a logistic-regression challenger scored in the shadow and an Isolation Forest anomaly flag |
| Lua scripting | `RUN_ANALYSIS` runs 13 logged steps as one call. `TRAIN_MODEL` and `PURGE_EXPIRED` (with SHA-256 proof) are Lua too. |
| Window functions and analytic SQL | Turn core-banking transactions and GST history into 13 credit features |
| `PREFERRING` (skyline) | Ranks the Pareto-best companies into the top 50 |
| Semantic views (exasol-semantic-views 0.5.1) | `CREDORA_SEM.PORTFOLIO` holds 16 certified metrics shared by the app and the AI |
| SQL preprocessor (preprocessor-framework 0.9.1) | Routes semantic SQL per role and skips a failing module |
| Preprocessor library (preprocessor-library 0.3.1) | `cast_shorthand` and `trailing_comma` for the roles that send AI-written SQL |
| Users, roles and GRANTs | One Exasol user per app role, so the database decides what each screen and the AI can read |
| Row-level security views | The relationship manager's views filter on `CURRENT_USER` |
| SQL audit (`EXA_DBA_AUDIT_SQL`, `EXA_DBA_AUDIT_SESSIONS`) | Every statement is tagged `credora:<app user>:<feature>` and shown on the admin's Exasol audit screen |
| `COMMENT ON` | Every Credora schema, table, column and script carries its meaning, which the MCP server hands to the AI |
| Consumer groups and `QUERY_TIMEOUT` | `CREDORA_BATCH` runs the analysis first. Ask Credora sessions get 60 s and 2 GiB in `CREDORA_AI`, so the AI cannot starve the analysis. |
| Exasol Scheduler (exasol-scheduler 0.4.1) | Runs `PURGE_EXPIRED` every 15 minutes and refreshes the virtual schemas nightly, logged in `SCHED.SCHED_HISTORY` |
| System tables | Audit, connections, columns, virtual schemas, scripts, grants and sessions feed the admin screens |
| Exasol MCP server (exasol-mcp-server 2.3.0) | Ask Credora queries Exasol as the signed-in role's own user, with writes switched off |
| Exasol console and control room (Explain mode) | The console lists each statement a screen sent to Exasol, with the user it ran as. The control room maps the database as that role sees it. |
| Exasol Personal launcher | Installs Exasol on EC2 with one command, its ports open to admin IPs only |

Each feature, with its code and the reason for it, is in [docs/WHY_EXASOL.md](docs/WHY_EXASOL.md).

## Roles, enforced by Exasol

Every app role reads Exasol as its own database user. The backend runs each screen's queries as that user, and Ask Credora starts the MCP server logged in as the same user. When Exasol refuses a query, the screen shows `403 Exasol denied access for your role`. Analysis, training and the purge run as the service user `CREDORA_SVC`.

| Login | Exasol user and role | What the app shows | What Ask Credora can read |
|---|---|---|---|
| `admin` | `CREDORA_ADMIN` / `R_ADMIN` | Data generation, sources, approvals, audit and purge, Loan status | Results, the semantic view, the three bank databases and raw 3rd party data |
| `datasci` | `CREDORA_DATASCI` / `R_DATASCI` | Runs and publishes the analysis, trains models, what-if and policy proposals | Same as admin |
| `loanops` | `CREDORA_LOANOPS` / `R_LOANOPS` | Published runs, assigning companies to managers, sanctioning escalations | Same as admin, without raw 3rd party data (`CREDORA_STAGE`) |
| `rm` | `CREDORA_RM` / `R_RM` | Only her assigned companies, at full detail, with negotiation and loan status | Only the row-filtered `V_RM_*` and `V_LATEST_*` views |

The RM logs the loan status one step at a time, from Contacted to Disbursed. Loan taken needs terms agreed within the negotiation limits or sanctioned by loan operations ([docs/API.md](docs/API.md#loan-status-state-machine)).

The `V_RM_*` views join `CREDORA.RM_ASSIGNMENT` on `EXA_USER = CURRENT_USER`, and `R_RM` has no grant on the result tables. Signed in to Exasol as `CREDORA_RM`, `V_RM_DECISIONS` returns her 25 companies and `SELECT * FROM CREDORA.DECISIONS` fails with "insufficient privileges". A prompt can't widen that, because the limit lives in the database.

![Roles and AI access. Four roles as rings of data, and one Ask Credora question going into Exasol as the role's own user](docs/img/05-roles-access.png)

## Verify it yourself

Every feature below can be tried on https://credora.loan and found in the code.

| Feature | Where to click | Code |
|---|---|---|
| The whole analysis is one Exasol call | `datasci`, Analysis runs, Run analysis, then any company report (13 steps with their SQL, Lua or Python and their time) | [06_run_analysis.sql](exasol/lua/06_run_analysis.sql) |
| Bank data is read in place | `admin`, Sources | [03_virtual_schemas.sql](exasol/sql/03_virtual_schemas.sql) |
| Oracle does the heavy aggregation | `admin`, Sources, Pushdown proof (`EXPLAIN VIRTUAL`) | [exasol_admin.py](backend/app/exasol_admin.py) |
| Exasol UDFs fetch the 3rd party data via API | https://credora.link shows the relays the UDFs call | [04_api_udfs.sql](exasol/udf/04_api_udfs.sql) |
| Models are trained and scored in Exasol | `datasci`, Risk models, Train champion and challenger | [05_ml_udfs.sql](exasol/udf/05_ml_udfs.sql) |
| Exasol filters the relationship manager's rows | `rm`, My companies lists 25 companies. Any other company's report returns 403. | [13_rm_row_security.sql](exasol/sql/13_rm_row_security.sql) |
| Ask Credora has the same grants | Ask the same cross-database question as `admin`, then as `rm` | [assistant.py](backend/app/assistant.py) |
| Every hand-off is maker-checker | Send a policy proposal as `datasci`, approve it as `admin` under Approvals | [policy.py](backend/app/policy.py) |
| The database records who ran what | `admin`, Exasol audit | [exa.py](backend/app/exa.py) `client_tag()` |
| 3rd party data is purged on schedule, with proof | `admin`, Exasol audit (scheduler runs), then Audit and purge | [08_purge.sql](exasol/lua/08_purge.sql), [17_scheduler.sql](exasol/sql/17_scheduler.sql) |
| The AI can't starve the analysis | Ask Credora sessions appear in Exasol audit as `credora:<role>:ask-credora` | [16_resources.sql](exasol/sql/16_resources.sql) |
| Every click shows what Exasol does | Explain mode, Exasol console and Exasol control room in the top bar | [console.py](backend/app/console.py), [explain/](frontend/src/explain/) |
| Everything rebuilds from this repo | One command in any AWS account | [credora.py](deploy/credora.py) |

## Setup and reproduction

Everything runs from your own machine against your own AWS account. Nothing in the code is tied to an account or a domain.

1. Install the [Exasol Personal Local Starter Kit](https://github.com/exasol-labs/exasol-personal-local-starterkit), following its README. It brings the `exasol` launcher from [exasol/exasol-personal](https://github.com/exasol/exasol-personal), `uv`, `pyexasol`, `exapump` and the Exasol MCP server. Check it with `exakit version` (Credora was built with 0.2.3) and `exasol version`.
2. Install the AWS CLI v2, Docker, Python 3.12, Node.js 20+ and Git.
3. Log in to AWS, and have a Route 53 hosted zone in that account. The default sizes need 6 vCPUs of on-demand EC2.
   ```bash
   aws configure --profile mysite
   aws sts get-caller-identity --profile mysite
   ```
4. Clone the repo and install the deploy tool.
   ```bash
   git clone https://github.com/anamika-iit-kgp/credora.git
   cd credora
   make setup   # or: uv venv deploy/.venv && uv pip install -p deploy/.venv -r deploy/requirements.txt
   ```
5. Copy `.env.example` to `.env.mysite` and fill it in. The name after `.env.` is the deployment name.

   | Variable | Set it to | Required |
   |---|---|---|
   | `AWS_PROFILE` | The profile from step 3 | yes |
   | `AWS_REGION` | Your region, for example `ap-south-1` | yes |
   | `DOMAIN` | Your Route 53 hosted zone, for example `mybank.example` | yes |
   | `EXTERNAL_DOMAIN` | A second hosted zone for the 3rd party data APIs | no |
   | `ADMIN_CIDR` | Your IP as `x.x.x.x/32` (blank detects it) | no |
   | `APP_*_PASSWORD` | Demo login passwords (blank means `Demo@123`) | no |
   | `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_MODEL` | `anthropic` with your key, or `bedrock` (blank turns the AI off) | no |

6. Deploy, then write every URL, login and password to `deployments/mysite/ACCESS.md`.
   ```bash
   python deploy/credora.py deploy --env mysite
   python deploy/credora.py access --env mysite
   ```

`deploy` is idempotent. It installs Exasol through the launcher, creates the RDS databases, app host and DNS with OpenTofu, starts the containers, generates 1,000 companies and sets up every Exasol object. Database and API passwords are generated into AWS Secrets Manager. Other commands (`status`, `ship`, `exasol`, `generate`, `destroy`) and moving a deployment to another machine are in [docs/PORTING.md](docs/PORTING.md).

To run only the tests (no AWS needed), install Python 3.12 and Node.js, then run `pip install -r backend/requirements.txt -r backend/requirements-dev.txt`, `python -m pytest -q backend/tests` and `npm ci && npm run build` in `frontend/`. The same checks run in [GitHub Actions](.github/workflows/ci.yml) on every push.

## Data sources, licences, APIs and third-party tools

All data is synthetic and made by Credora's own generator ([mocks/generator](mocks/generator)), with seed 2026 on the live site. The live data set starts at 1,000 companies, and the admin can add more with one click. Sapphire Bank, its companies, their partners, accounts, transactions, GST returns and credit reports are invented. No real person, company or bank record is used. The generator can replace the data set or add more companies with unique names, PANs, GSTINs and account numbers.

| Source | What it holds | Where it lives | How Exasol reads it |
|---|---|---|---|
| Core banking | Accounts and about 850,000 transactions | Amazon RDS for Oracle (SE2, licence included) | Virtual schema `VS_CBS` |
| Customer master | Companies, partners, relationship managers, KYC | Amazon RDS for MySQL 8.4 | Virtual schema `VS_CIF` |
| Loan origination | Each company's credit need on file and 5,000 past loans | Amazon RDS for PostgreSQL 16 | Virtual schema `VS_LOS` |
| CIBIL (credit bureau) | Partner and company credit reports | Mock API at https://cibil.credora.link | Python UDFs over HTTPS |
| GSTN | GST registrations and monthly returns | Mock API at https://gst.credora.link | Python UDFs over HTTPS |
| Account Aggregator | Consented accounts at other banks | Mock API at https://aa.credora.link | Python UDFs over HTTPS |

The three mock APIs are written for this project ([mocks/](mocks)). They follow the shape of the real services, but no real CIBIL, GSTN or Account Aggregator API is called, and no credentials for them are needed. Their contracts are in [docs/API.md](docs/API.md).

Ask Credora and the credit memos call Claude through the Anthropic API (model `claude-sonnet-5-5`), under Anthropic's commercial terms. Amazon Bedrock can be used instead. Without an AI key the rest of the app works.

The third-party tools and their licences are below.

| Tool | Used for | Licence |
|---|---|---|
| Exasol Personal 2026.1 | The analytics database | Free for personal use, under Exasol's terms. The launcher is MIT |
| Exasol open source projects (see the thank-you table below) | Virtual schemas, script languages, semantic views, preprocessors, scheduler, MCP server, drivers | MIT, except script-languages-release, which is GPL-3.0 |
| Oracle Database SE2, MySQL, PostgreSQL | The bank's source databases on Amazon RDS | Licence included in RDS (Oracle), GPL-2.0 (MySQL), PostgreSQL Licence |
| scikit-learn, NumPy | ML models inside Exasol UDFs | BSD-3-Clause |
| FastAPI, Uvicorn, httpx, PyJWT, psycopg, PyMySQL, python-oracledb, boto3 | The backend and the mock APIs | MIT, BSD, LGPL-3.0 (psycopg), Apache-2.0 (oracledb, boto3) |
| Anthropic Python SDK, MCP Python SDK | Ask Credora and credit memos | MIT |
| React, React Router, TanStack Query, Motion, Lucide icons | The web app | MIT, ISC (Lucide) |
| IBM Plex and Literata fonts | Typography | SIL Open Font Licence 1.1 |
| OpenTofu, Caddy, Docker | Infrastructure as code, HTTPS, containers | MPL-2.0, Apache-2.0, Apache-2.0 |
| AWS (EC2, RDS, S3, Route 53, Secrets Manager) | Hosting, in my own AWS account | AWS customer agreement |

Exasol, Oracle, MySQL, PostgreSQL and other names and logos belong to their owners and appear only to identify the systems used. Credora's own code is MIT licensed.

## Demo video and supporting materials

| Material | Link |
|---|---|
| Demo video | https://video.credora.loan |
| Presentation (animated slides, and a PDF to download) | https://ppt.credora.loan |
| Live app with four demo logins | https://credora.loan |
| Docs site, with the architecture and glossary | https://docs.credora.loan |
| 3rd party data APIs | https://credora.link |
| Architecture diagrams | The table below and [docs/diagrams](docs/diagrams/index.html) |

The docs, presentation and video sites each show a simple view count, also listed next to their links in the app. Only one number per site is stored, nothing about visitors. The video page plays whatever file a `video.json` next to it points to, so the video can be published without a code change.

## Diagrams

| Diagram | Image | Interactive |
|---|---|---|
| Big picture | [PNG](docs/img/01-big-picture.png) | [HTML](docs/diagrams/01-big-picture.html) |
| AWS deployment | [PNG](docs/img/02-aws-deployment.png) | [HTML](docs/diagrams/02-aws-deployment.html) |
| Inside Exasol | [PNG](docs/img/03-inside-exasol.png) | [HTML](docs/diagrams/03-inside-exasol.html) |
| Analysis flow | [PNG](docs/img/04-analysis-flow.png) | [HTML](docs/diagrams/04-analysis-flow.html) |
| Roles and AI access | [PNG](docs/img/05-roles-access.png) | [HTML](docs/diagrams/05-roles-access.html) |

The full design, with failure modes and trade-offs, is in [docs/architecture.html](docs/architecture.html).

## Repository layout

```
exasol/     SQL, Python UDFs, Lua scripts, preprocessor modules and the semantic model
backend/    FastAPI with roles, jobs, Ask Credora and the Exasol audit
frontend/   React and TypeScript, with Explain mode
mocks/      mock CIBIL, GSTN and Account Aggregator APIs and the data generator
deploy/     the one-command deploy tool, with infra/ (OpenTofu) beside it
docs/       architecture, diagrams, glossary, data model, APIs, porting
```

## Documentation

| Document | Covers |
|---|---|
| [docs.credora.loan](https://docs.credora.loan) | The live docs site |
| [docs/architecture.html](docs/architecture.html) | The full design, roles, decision logic, deployment and failure modes |
| [docs/WHY_EXASOL.md](docs/WHY_EXASOL.md) | Every Exasol feature used, where and why |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Every Exasol, banking, AI and AWS term in plain words |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Bank schemas, mock API data and feature definitions |
| [docs/API.md](docs/API.md) | The mock API contracts and the web app's API |
| [docs/PORTING.md](docs/PORTING.md) | Deploying to another AWS account or domain |

## Built with Exasol open source, thank you

Every project below runs in the live deployment or in CI. Thank you to the Exasol team and to everyone who contributes to them.

| Project | What it does in Credora |
|---|---|
| [exasol-labs/exasol-personal-local-starterkit](https://github.com/exasol-labs/exasol-personal-local-starterkit) | The starter kit (`exakit` 0.2.3) Credora began on, with local Exasol, MCP setup, `exapump` and `pyexasol` |
| [exasol/exasol-personal](https://github.com/exasol/exasol-personal) | Exasol Personal and its launcher, which deploys the database on AWS |
| [exasol/oracle-virtual-schema](https://github.com/exasol/oracle-virtual-schema) | `VS_CBS`, core banking in RDS Oracle, read live with pushdown |
| [exasol-labs/adbc-vs-rs](https://github.com/exasol-labs/adbc-vs-rs) | `VS_CIF` and `VS_LOS`, the MySQL and PostgreSQL databases, read live through ADBC |
| [exasol-labs/language-container-rs](https://github.com/exasol-labs/language-container-rs) | The Rust script language container that runs the adbc-vs-rs adapter |
| [exasol/script-languages-release](https://github.com/exasol/script-languages-release) | The Python 3 and Java containers behind the API, ML and AI UDFs |
| [exasol-labs/exasol-semantic-views](https://github.com/exasol-labs/exasol-semantic-views) | `CREDORA_SEM.PORTFOLIO`, the certified metrics for the app and the AI |
| [exasol-labs/preprocessor-framework](https://github.com/exasol-labs/preprocessor-framework) | Owns the SQL preprocessor slot and routes semantic SQL per role |
| [exasol-labs/preprocessor-library](https://github.com/exasol-labs/preprocessor-library) | `cast_shorthand` and `trailing_comma` (0.3.1) for AI-written SQL |
| [exasol-labs/exasol-scheduler](https://github.com/exasol-labs/exasol-scheduler) | Release 0.4.1 runs the purge every 15 minutes and the nightly virtual schema refresh |
| [exasol/udf-mock-python](https://github.com/exasol/udf-mock-python) | Tests the deployed `ANOMALY_FLAG` and `PD_SCORE` UDF code in CI |
| [exasol/mcp-server](https://github.com/exasol/mcp-server) | `exasol-mcp-server` 2.3.0, through which Ask Credora queries Exasol |
| [exasol/pyexasol](https://github.com/exasol/pyexasol) | The Python driver for the backend and the deploy tool |
| [exasol-labs/exapump](https://github.com/exasol-labs/exapump) | The starter kit's SQL and bulk-load CLI |
| [exasol/virtual-schemas](https://github.com/exasol/virtual-schemas) | The virtual schema framework the Oracle adapter builds on |

## About, contributing and contact

Credora is an ExaThon India 2026 project. It is a try-out of the Exasol Personal Local Starter Kit and of Exasol Personal, deployed on AWS. The live deployment runs in my own AWS account, on the domains `credora.loan` and `credora.link`, which I registered for this project.

Contributions are welcome. Fork the repo and open a pull request, or open an issue first for a larger change. To build on Credora, adapt it for your bank, or buy or license it, raise an [issue](https://github.com/anamika-iit-kgp/credora/issues) and I will get in touch.

Project by Anamika, Product Manager @ Equitas Small Finance Bank. Sapphire Bank is fictional, and all data is synthetic.

## License

MIT. See [LICENSE](LICENSE).
