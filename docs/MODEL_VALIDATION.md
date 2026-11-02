# Model validation in Credora

Credora decides pre-approved offers with a probability-of-default model that is trained, stored and scored inside Exasol. This page describes the evidence Credora keeps about that model and shows on the Risk models screen. There are two parts. The calibration of each registered model on the training's own hold-out, and the population stability index (PSI) of every analysis run's features against the past loans the model learnt from. Both are computed inside Exasol, stored in two tables of the `CREDORA` schema and read by the admin and the data scientist. All data in Credora is synthetic.

| Evidence | Table | Computed by | When |
|---|---|---|---|
| Calibration on the hold-out | `CREDORA.MODEL_CALIBRATION`, one row per model version and decile | `CREDORA.CALIBRATE_MODEL(version)`, a Lua script that runs the Python UDF `CREDORA.PD_CALIBRATE` over `VS_LOS.past_loan_training` | after every training (step 6 of the training job), and on demand from the Risk models screen or `POST /api/ml/models/{version}/calibration` |
| Population stability | `CREDORA.MODEL_PSI`, one row per run and model feature | `CREDORA.COMPUTE_PSI(run_id)`, a Lua script over `CREDORA.FEATURES` and `VS_LOS.past_loan_training` | after every analysis run, and on demand from the Risk models screen or `POST /api/ml/psi` |

The objects are created by `exasol/sql/19_model_validation.sql` (tables, both Lua scripts, grants) and `exasol/udf/05_ml_udfs.sql` (the UDF). Both scripts run as `CREDORA_SVC`. The schema grant in `exasol/sql/07_security.sql` lets `R_ADMIN`, `R_DATASCI` and `R_LOANOPS` read the tables, and `19_model_validation.sql` repeats the grant on each table so the intent stays visible.

## 1. Calibration on the hold-out

### What is computed

Both trainers (`CREDORA.TRAIN_PD`, the gradient-boosted champion, and `CREDORA.TRAIN_SCORECARD`, the logistic challenger) sort the past loans by `loan_id`, hold out a stratified 25% with seed 7, measure the AUC on that hold-out and then refit the model on every past loan for production. The AUC in `MODEL_REGISTRY` is therefore a hold-out figure, but the registered file has seen every loan.

`PD_CALIBRATE` repeats that split exactly. It loads the registered pickle from BucketFS (after checking its SHA-256 against `MODEL_REGISTRY.MODEL_SHA256`, as `PD_SCORE` does), takes an unfitted copy of the model's recipe with `sklearn.base.clone` (same algorithm, same hyperparameters, same seed), fits it on the 75% and scores the 25%. Every figure below is therefore on loans the scored model did not learn from. Scoring the registered file itself on that slice would be in-sample, and the page never does that.

The hold-out is cut into ten equal-count groups by predicted PD, lowest first. For each decile the table stores

| Column | Meaning |
|---|---|
| `N`, `DEFAULTS` | loans in the decile and how many of them defaulted |
| `MEAN_PD` | mean predicted probability of default in the decile |
| `OBSERVED_RATE` | share of the decile that defaulted |
| `PD_MIN`, `PD_MAX` | the range of predicted PD in the decile |
| `BRIER` | Brier score on the whole hold-out, the mean squared gap between the predicted PD and the 0/1 outcome. Lower is better, and 0.25 is a coin toss |
| `BRIER_BASE` | the Brier score of always predicting the training default rate, the no-skill reference |
| `AUC` | the AUC `PD_CALIBRATE` reproduced on the hold-out |
| `REGISTRY_AUC` | the AUC the trainer wrote to `MODEL_REGISTRY` |
| `N_HOLDOUT`, `COMPUTED_AT` | the size of the hold-out and when the row was written |

The whole-hold-out figures are repeated on every decile row of a version, so one read gives the table and the summary.

### How to read it

- **The deciles.** A calibrated model shows `MEAN_PD` and `OBSERVED_RATE` close together in every decile. The screen draws both as bars. The sentence under the metrics names the largest gap in percentage points. Below 2 points the PDs can be read as probabilities. Between 2 and 5 points the ranking holds and the PDs are close. Above 5 points the ranking may still hold, but the PDs should be recalibrated before anyone prices on them. The grade thresholds in `RUN_ANALYSIS` step 9 (A1 below 1%, A2 below 2% and so on) and the floor rate in the decision SQL (`PD * LGD`) both read the PD as a probability, which is why calibration matters here and not only the ranking.
- **Brier against its base.** `BRIER` below `BRIER_BASE` means the probabilities carry information beyond the base rate. The screen states the improvement as a share of the base (the Brier skill score). With a default rate near 8% the base is about 0.07, so a Brier of 0.06 is a clear improvement.
- **AUC against the registry.** `AUC` equals `REGISTRY_AUC` as long as the past loans are the ones the model learnt from, because the split, the recipe and the seed are the trainers' own. If the two differ, the past loans changed since the training (a data generation with `replace` or `append`), the hold-out is no longer the training's, and the model should be retrained before its calibration is quoted. The screen says which case applies.
- **What it does not show.** The registered file was refit on all past loans, so its own calibration is close to, not identical with, the twin's. The hold-out is 1,250 loans with about 100 defaults, so a decile holds roughly 10 defaults and the observed rate in one decile moves by a point or two from chance alone. Read the shape across deciles, not one decile.

### Running it for an existing model

`CALIBRATE_MODEL` works for any version in `MODEL_REGISTRY` without training a new one. For the live deployment, once, as `CREDORA_SVC` or the deploy user

```sql
EXECUTE SCRIPT CREDORA.CALIBRATE_MODEL('v3');
EXECUTE SCRIPT CREDORA.CALIBRATE_MODEL('v3-lr');
```

The Risk models screen does the same through `POST /api/ml/models/{version}/calibration` (data scientist or admin), and every later training writes the rows for its two new versions on its own.

## 2. Population stability index

### What is computed

For each of the 13 model features, `MODEL_PSI` compares two populations. The training population is every row of `VS_LOS.past_loan_training`, the 5,000 past loans both models learnt from. The live population is `CREDORA.FEATURES` of one run, the companies analysed in it. Ten bins are fixed on the training population. The upper edge of bin k is the largest value in the k-th tenth of the past loans, and the last bin is open. Both populations are counted into those bins, and

```
PSI = sum over bins of (live share - train share) * ln(live share / train share)
```

An empty share counts as 0.0001 so the logarithm is defined, and a bin that is empty on both sides adds nothing. Companies without a value for a feature (`GST_LATE_FILINGS_12M` is NULL when a company has no GST returns on file) are left out of the shares and counted in `NULL_LIVE`. The table also keeps the mean of the feature in each population and the ten pairs of shares as JSON in `BINS`, which the screen draws as ten pairs of small bars.

### How to read it

The usual reading, which the screen prints next to the figures.

| PSI | Reading |
|---|---|
| below 0.1 | stable, the run's companies look like the past loans on this feature |
| 0.1 to 0.25 | some shift, worth a look |
| above 0.25 | significant shift, the model is scoring companies unlike the ones it learnt from on this feature |

A PSI is per feature. A model can be stable on most features and shifted on one, and the screen lists the features with the largest shift first. What matters for a decision is whether the shifted feature carries weight in the model (see the feature importance and the coefficients on the same screen) and whether the shift grows from run to run.

### The known gap between past loans and live features

Credora's PSI shows shift on several features even on the first run, and that is expected. The past loans and the live features come from the same hidden risk process but not from the same formulas.

- The generator draws each past loan's features by formula from the company's latent risk (`past_loan_features` in `mocks/generator/generator/risk.py` and `synth.py`, around lines 766 to 816 of `synth.py`). For example `avg_balance_12m` is `annual turnover / 12 * balance months`, `inflow_volatility` is the spread of twelve simulated monthly sales figures, `partner_other_bank_bal` is the closing balance of a simulated account walk, and `dscr` uses a tenure drawn for the past loan.
- The live features are computed by `RUN_ANALYSIS` step 7 from the ledgers, returns and reports Exasol reads in place (`docs/DATA_MODEL.md` section 8). `AVG_BALANCE_12M` is the mean balance after every current-account transaction in the window, `INFLOW_VOLATILITY` is the spread of the twelve monthly credit totals, with seasonality and growth in them, `PARTNER_OTHER_BANK_BAL` is the sum of the partners' current balances at other banks, and `DSCR` uses the tenure of the credit need on file.

So a feature can move between the two populations even when the companies are alike. This is a train/serve skew, and it is kept on purpose. A bank's loan history is a snapshot whose features were computed by an older pipeline, and the PSI is exactly the instrument that makes such a gap visible instead of leaving it inside the model. The generator is not changed for this evidence. What PSI is useful for in Credora is the change from run to run, for example after a data generation with `append`, and the honest statement that the live population differs from the training population on the features it names. Where a shifted feature also carries weight in the model, the right response is to recompute the past-loan features with the live formulas and retrain, which is the usual answer to feature skew in a bank too.

### Running it for a run

`MODEL_PSI` works for any run that has rows in `CREDORA.FEATURES`, published or draft. Once, as `CREDORA_SVC` or the deploy user

```sql
EXECUTE SCRIPT CREDORA.COMPUTE_PSI('R20261031-1923');
```

The Risk models screen shows the latest published run and recomputes it through `POST /api/ml/psi` (data scientist or admin). `GET /api/ml/psi?run_id=` reads any run.

## 3. Regulatory reference

The Reserve Bank of India published the draft circular **Regulatory Principles for Management of Model Risks in Credit** (RBI/2024-25/DOR.STR.REC./21.04.048/2024-25, dated 5 August 2024, issued for public comments until 4 September 2024). It applies to the models a regulated entity uses in credit decisions, including pricing and risk assessment, and asks for a board-approved model risk policy, a record of every model with its purpose and owner, validation by people independent of the model's development before a model is used and again on a set cycle, and ongoing monitoring of the model's inputs and outputs against the data it was built on. The circular was a draft at the time of writing. Check the RBI site for the final text before quoting a clause.

What Credora covers of that, and where.

| Principle | In Credora |
|---|---|
| A record of every model | `CREDORA.MODEL_REGISTRY` with version, algorithm, training date, AUC, Gini, feature importance, file path and SHA-256 |
| Validation before use | the hold-out AUC and Gini at training, the calibration deciles and Brier score of this page, the challenger scored in the shadow on every run |
| Approval before use | a model decides only after the data scientist requests its activation and the admin approves it (maker-checker, `crm.model_activation_request`) |
| Monitoring of inputs | the PSI of every run's features against the training population, per feature, kept per run |
| Integrity of the deployed model | `PD_SCORE` and `PD_CALIBRATE` refuse a model file whose SHA-256 differs from the registry |
| Explainability | per-company feature attribution in `SCORES.CONTRIBUTIONS`, monotonic constraints in the champion |

What Credora does not do. There is no validation team independent of development, no annual cycle, no outcome monitoring of the pre-approved offers it issued (the synthetic data carries no later defaults for the companies analysed), and the data is synthetic throughout. The page is evidence of the method, not a validation report for a real portfolio.

Sources. [RBI press release of 5 August 2024](https://website.rbi.org.in/web/rbi/-/press-releases/rbi-releases-draft-circular-on-regulatory-principles-for-management-of-model-risks-in-credit-) and the [draft circular text](https://www.rbi.org.in/scripts/bs_viewcontent.aspx?Id=4479).

## 4. Where to look

- Screen. Risk models, panels "Calibration on the hold-out" (for the picked version) and "Population stability" (for the latest published run), with Compute and Recompute buttons for the data scientist and the admin.
- API. `GET` and `POST /api/ml/models/{version}/calibration`, `GET` and `POST /api/ml/psi` (`docs/API.md`).
- Tables. `CREDORA.MODEL_CALIBRATION`, `CREDORA.MODEL_PSI`, with every column described in Exasol by `COMMENT ON` (`exasol/sql/15_comments.sql`).
- Tests. `tests/udf/test_ml_udfs.py` trains the scorecard in the UDF mock and checks that `PD_CALIBRATE` reproduces its hold-out AUC and emits ten ordered deciles. `backend/tests/test_validation.py` covers the payloads, the endpoints and the roles.
- Glossary. [Calibration](GLOSSARY.md#calibration) and [Population Stability Index (PSI)](GLOSSARY.md#psi).
