# Changelog

All notable changes to Credora. Dates are in IST.

## 1.1.0

- Ask Credora sessions log in as the person's own AI user (`CREDORA_ADMIN_AI`, `CREDORA_DATASCI_AI`, `CREDORA_LOANOPS_AI`, `CREDORA_RM_AI`) with the same role, placed in consumer group `CREDORA_AI` (low priority, 60 s statement limit, 2 GiB temp memory). The admin's AI user has no dictionary access, so the AI cannot read the audit log. A role with no AI password gets a 503, with no fallback user, and `CREDORA_MCP` stays only for AI clients outside the app.
- A second relationship manager user, `CREDORA_RM002`, and a control room panel "Row-level security, proven by Exasol" (`GET /api/admin/rls-proof`) that runs the same SELECT as `CREDORA_RM`, `CREDORA_RM_AI` and `CREDORA_RM002` and shows the refusal on `CREDORA.DECISIONS`.
- `MODEL_REGISTRY` has `MODEL_VERSION` as its primary key and a `MODEL_SHA256` column with the SHA-256 of each model file. `PD_SCORE` hashes the file and refuses a mismatch before unpickling. `GET /api/ml/models` returns `model_sha256`.
- The API UDFs make 3 attempts, with 1 s and 2 s pauses, and fail with an error that names the service.
- A failed analysis step stays in `RUN_LOG` (COMMIT before the error).
- A company with no GST returns on file is now referred with the reason "No GST returns on file". Before 1.1.0 it was declined.
- `PURGE_EXPIRED` fingerprints expiring rows per 1,000-row chunk (SHA-256 of the chunk hashes), because one run's GST rows exceed Exasol's 2,000,000-character VARCHAR limit for LISTAGG. On the live data that is 72 chunks of up to 33,325 characters per run. It skips when an analysis logged a step in the last 3 minutes.
- Step 7 groups Oracle transactions by `TO_CHAR(date, 'YYYY-MM')` because the Oracle adapter does not push down `TRUNC(date, 'MM')`. The step went from 10.8 s to 3.6 s and the run from 24.7 s to 17.5 s.
- The Overview has a four-step demo rail with a Switch role menu, and a permanent Exasol strip in the top bar shows the screen, its statements, their time and the Exasol user, and opens the console.
- The deploy tool gained `python deploy/credora.py infra --env <name>`, which runs OpenTofu only.
- The Overview caches source counts for 60 s. The audit screen masks `IDENTIFIED BY` secrets with `REGEXP_REPLACE` inside Exasol, before the text leaves the database.
- A relationship manager's refused read returns a 403 that carries the refused SQL, and the screen shows "Exasol refused this read for CREDORA_RM" with that SQL.
- The company report shows "How Exasol decided" above the credit memo, with the decision step open.
- Explain mode shows one toast at a time, for 10 s, and one band per screen per session.
- The main JavaScript bundle went from 497 kB to 428 kB (163 kB to 137 kB gzip).
- The CRM table `offer` has a unique index on (`run_id`, `app_id`).
- Tests. `tests/udf` covers both trainers and the SHA-256 they emit, `PD_SCORE` refusing a mismatched hash, `MODEL_FILE_SHA256` and the retry helper of all four fetch UDFs. `backend/tests` gained tests for the atomic job guard, the busy pool mapped to 503, the overview count cache and the audit mask.
- The diagrams in `docs/img` were re-rendered with the corrected wording (16 batches, 4 at a time, 17.5 s, the exasol-labs Rust container).
- Docs. Impact figures, a problem statement, banking notes, cost and time, local runs on the starter kit, known limitations, troubleshooting, and the AUC explained. New CONTRIBUTING, SECURITY, CODE_OF_CONDUCT and issue templates.

## 1.0.0, 31 October 2026

- First release, submitted to ExaThon India 2026. Live at https://credora.loan with docs, presentation and video sites, and the mock 3rd party data APIs at https://credora.link.
- `RUN_ANALYSIS` in Lua, 13 logged steps over three virtual schemas (Oracle, MySQL, PostgreSQL) and three API UDFs (CIBIL, GSTN, Account Aggregator).
- Champion gradient-boosted trees and challenger logistic scorecard trained in Exasol UDFs, scored with explanations, with an Isolation Forest anomaly flag and shadow scoring on every run.
- `PREFERRING` skyline ranking for the Top 50, the semantic view `CREDORA_SEM.PORTFOLIO` behind the preprocessor framework, and `COMMENT ON` for every object.
- One Exasol user per role, row-level security views for relationship managers, SQL audit tagged per app user and screen, consumer groups, and the Exasol Scheduler for the purge and the nightly refresh.
- Ask Credora through the official Exasol MCP server, Explain mode, the Exasol console and the control room.
- One-command deploy to any AWS account with the Exasol Personal launcher and OpenTofu.
