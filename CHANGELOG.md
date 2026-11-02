# Changelog

All notable changes to Credora. Dates are in IST.

## 2.0.0, 2 November 2026

- Scale-up evidence. The same `RUN_ANALYSIS` was measured at 1,000, 10,000 and 50,000 companies on the live single node (17.4 s, 67.7 s and 319.5 s, peak temporary RAM 425 MiB, 625 MiB and 1,332 MiB). The per-step table with rows, seconds, CPU and temp RAM from `EXA_DBA_AUDIT_SQL` is in `docs/WHY_EXASOL.md` and on a deck slide. The inside-Exasol steps scale close to linearly and the 3rd party API fetches set the wall clock. The generator gained an optional `as_of` date so a data set can be drawn again later (`seed` and `as_of` together give the same data).
- Offers are priced with an operating cash margin per industry (`CREDORA.INDUSTRY_MARGIN`, 5% to 22%, illustrative) instead of a flat 12% of GST turnover, in the DSCR feature, the offer size and the negotiation limit. An industry not in the table gets `CONFIG CASH_MARGIN_DEFAULT_PCT`.
- Loss given default follows the collateral (`CREDORA.LGD_COLLATERAL`, Basel II foundation IRB style figures) blended with the unsecured 45% by the share of the credit need the collateral covers. The floor ROI, RAROC, the RM's quote and the certified `expected_loss` use it, so collateral changes expected loss and not only the rate card.
- The CIBIL commercial report's total exposure now sizes the offer. Existing exposure plus the offer stays within `CONFIG MAX_EXPOSURE_PCT` (60%) of GST turnover, and the negotiation limit respects the same room. The referral reason "Existing exposure near the cap" names it.
- `DECISIONS` stores the inputs it priced with (`CASH_MARGIN_PCT`, `LGD_PCT`, `EXISTING_EXPOSURE`, `EXPOSURE_ROOM`), `FEATURES` keeps `CIBIL_TOTAL_EXPOSURE`, and the report shows a "Priced with" block. `GET /api/companies/{cif}/report` returns `pricing`, the quote returns `lgd_pct`. Existing deployments get the columns in place (`CREDORA.PRICING_MIGRATE`). New `docs/PRICING.md` writes the rule out end to end, and the mock generator uses the same margins for past loans, kept in step by a test.
- Model-validation evidence on the Risk models screen. `CREDORA.CALIBRATE_MODEL` (Python UDF `PD_CALIBRATE`) repeats the trainers' 25% hold-out split over the past loans, fits a fresh copy of the registered model's recipe and stores per decile of predicted PD the count, mean PD and observed default rate with the Brier score and AUC in `CREDORA.MODEL_CALIBRATION`. It runs after every training and on demand, also for the existing v3 models.
- `CREDORA.MODEL_PSI` stores the population stability index of every run's features against `VS_LOS.past_loan_training`, per feature, in `CREDORA.MODEL_PSI`, after every run and on demand. The screen reads it with the usual thresholds (below 0.1 stable, 0.1 to 0.25 some shift, above 0.25 significant). New endpoints `GET` and `POST /api/ml/models/{version}/calibration` and `GET` and `POST /api/ml/psi` (data scientist, admin). New `docs/MODEL_VALIDATION.md` with the reading guide, the known gap between the formula-drawn past loans and the ledger-derived live features, and the RBI draft circular of 5 August 2024 on model risk in credit.
- A GitHub Actions job, Exasol SQL on docker-db (`.github/workflows/exasol.yml`), applies every SQL, Lua and UDF file in deploy order to a throwaway `exasol/docker-db` 2026.1.0 on each push and pull request, creates the roles, users, consumer groups and the preprocessor framework through the deploy tool's own code, loads a run of 50 synthetic companies, decides and ranks it with the real decision SQL and the `PREFERRING` skyline, and checks as each Exasol user what it may read. `CREDORA_RM` and its AI session user see only their 25 companies, `CREDORA_RM002` its own 5, and a direct `SELECT` on `CREDORA.DECISIONS` is refused. `PURGE_EXPIRED` runs as `CREDORA_SVC`, skips while a run is in progress, and its `PURGE_LOG` fingerprints are recomputed by the auditor's rule. About 3 minutes per run. The virtual schemas, the semantic model and the preprocessor-library modules are skipped with their reasons in `tests/exasol/run_docker_db.py`, and the job fails when `deploy/credora.py` names a SQL file the runner does not know.
- Ask Credora and the backend credit memo run on Claude in Amazon Bedrock with `AI_PROVIDER=bedrock`, through the Anthropic SDK's Bedrock client and the app host's instance role, so no API key is stored. The new `BEDROCK_MODEL_ID` names the Bedrock model id or inference profile, and blank means `anthropic.` followed by `AI_MODEL`. The memo written inside Exasol calls the Anthropic API from its UDF, so it stays Anthropic only and Bedrock always writes the memo in the backend. `backend/requirements.txt` pins `anthropic[bedrock]==2.3.0`.
- The glossary term data loads on demand instead of sitting in the main JavaScript bundle, which cuts the main chunk from 438 kB to 341 kB (140 kB to 110 kB gzip). The glossary gains cash margin, LGD by collateral, exposure cap, calibration and PSI.
- The mock data generator tests have `mocks/generator/requirements-dev.txt`, and `python -m pytest mocks/generator/tests` runs from the repo root. CI and CONTRIBUTING.md use it.

## 1.2.0, 2 November 2026

- The demo video is published at https://video.credora.loan and ships in the repository as `media/demo.mp4` (2 min 56 s, 1080p H.264 with a voice-over and burned-in captions). The narration is in `media/demo-transcript.md`, `media/demo.srt` and `media/demo.vtt`. The video page serves a full quality `demo-hq.mp4` when one is present (kept out of the repository) and offers the captions as a track. The files carry no metadata beyond their title and author.
- README gains a "Presentation and demo video" section with the repository and live links for both.

## 1.1.0, 1 November 2026

- Ask Credora sessions log in as the person's own AI user (`CREDORA_ADMIN_AI`, `CREDORA_DATASCI_AI`, `CREDORA_LOANOPS_AI`, `CREDORA_RM_AI`) with the same role, placed in consumer group `CREDORA_AI` (low priority, 60 s statement limit, 2 GiB temp memory). The admin's AI user has no dictionary access, so the AI cannot read the audit log. A role with no AI password gets a 503, with no fallback user, and `CREDORA_MCP` stays only for AI clients outside the app.
- A second relationship manager user, `CREDORA_RM002`, and a control room panel "Row-level security, proven by Exasol" (`GET /api/admin/rls-proof`) that runs the same SELECT as `CREDORA_RM`, `CREDORA_RM_AI` and `CREDORA_RM002` and shows the refusal on `CREDORA.DECISIONS`.
- `MODEL_REGISTRY` has `MODEL_VERSION` as its primary key and a `MODEL_SHA256` column with the SHA-256 of each model file. `PD_SCORE` hashes the file and refuses a mismatch before unpickling. `GET /api/ml/models` returns `model_sha256`.
- The API UDFs make 3 attempts, with 1 s and 2 s pauses, and fail with an error that names the service.
- A failed analysis step stays in `RUN_LOG` (COMMIT before the error).
- A company with no GST returns on file is now referred with the reason "No GST returns on file". Before 1.1.0 it was declined.
- `PURGE_EXPIRED` fingerprints expiring rows per 1,000-row chunk (SHA-256 of the chunk hashes), because one run's GST rows exceed Exasol's 2,000,000-character VARCHAR limit for LISTAGG. On the live data that is 72 chunks of up to 33,325 characters per run. It skips when an analysis logged a step in the last 3 minutes.
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
- Step 7 groups Oracle transactions by `TO_CHAR(date, 'YYYY-MM')` because the Oracle adapter does not push down `TRUNC(date, 'MM')`. The step went from 10.8 s to 3.6 s and the run from 24.7 s to 17.5 s.
