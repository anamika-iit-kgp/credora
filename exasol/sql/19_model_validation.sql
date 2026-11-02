-- Model-validation evidence, kept in Exasol next to the models it describes.
--
--   MODEL_CALIBRATION  calibration of one registered model on the training's own hold-out, one row per
--                      decile of predicted PD. Written by CALIBRATE_MODEL through the Python UDF
--                      PD_CALIBRATE (exasol/udf/05_ml_udfs.sql).
--   MODEL_PSI          population stability index per analysis run and model feature. It compares the
--                      past loans the models learnt from (VS_LOS.past_loan_training) with the live
--                      FEATURES of the run, in ten bins fixed on the past loans. Written by MODEL_PSI.
--
-- Both scripts run as CREDORA_SVC. The web app runs CALIBRATE_MODEL after every training and MODEL_PSI
-- after every analysis run, and the Models screen runs either on demand. The admin and the data
-- scientist read the tables. How to read the figures, and the known gap between the past loans and
-- the live features, are in docs/MODEL_VALIDATION.md.

CREATE TABLE IF NOT EXISTS CREDORA.MODEL_CALIBRATION (
  MODEL_VERSION VARCHAR(20) NOT NULL,
  DECILE        DECIMAL(2) NOT NULL,
  N             DECIMAL(10),
  DEFAULTS      DECIMAL(10),
  MEAN_PD       DECIMAL(9,6),
  OBSERVED_RATE DECIMAL(9,6),
  PD_MIN        DECIMAL(9,6),
  PD_MAX        DECIMAL(9,6),
  N_HOLDOUT     DECIMAL(10),
  BRIER         DECIMAL(9,6),
  BRIER_BASE    DECIMAL(9,6),
  AUC           DECIMAL(6,4),
  REGISTRY_AUC  DECIMAL(6,4),
  COMPUTED_AT   TIMESTAMP,
  CONSTRAINT MODEL_CALIBRATION_PK PRIMARY KEY (MODEL_VERSION, DECILE)
);

CREATE TABLE IF NOT EXISTS CREDORA.MODEL_PSI (
  RUN_ID      VARCHAR(20) NOT NULL,
  FEATURE     VARCHAR(40) NOT NULL,
  PSI         DECIMAL(9,6),
  N_TRAIN     DECIMAL(10),
  N_LIVE      DECIMAL(10),
  NULL_LIVE   DECIMAL(10),
  TRAIN_MEAN  DOUBLE,
  LIVE_MEAN   DOUBLE,
  BINS        VARCHAR(2000),
  COMPUTED_AT TIMESTAMP,
  CONSTRAINT MODEL_PSI_PK PRIMARY KEY (RUN_ID, FEATURE)
);

-- CREDORA.CALIBRATE_MODEL(model_version) replaces the calibration rows of one registered model. The
-- UDF reads every past loan through VS_LOS, repeats the trainers' hold-out split, fits a fresh copy
-- of the model's recipe on the rest and scores the hold-out. REGISTRY_AUC is the AUC the trainer
-- recorded, so a reader can see that the hold-out reproduced here is the one the training measured.
CREATE OR REPLACE LUA SCRIPT CREDORA.CALIBRATE_MODEL(model_version) RETURNS ROWCOUNT AS
  local m = query([[SELECT MODEL_PATH, MODEL_SHA256, AUC FROM CREDORA.MODEL_REGISTRY WHERE MODEL_VERSION = :v]],
                  {v = model_version})
  if #m == 0 then error('No model ' .. model_version .. ' in CREDORA.MODEL_REGISTRY') end
  query([[DELETE FROM CREDORA.MODEL_CALIBRATION WHERE MODEL_VERSION = :v]], {v = model_version})
  local res = query([[
    INSERT INTO CREDORA.MODEL_CALIBRATION (MODEL_VERSION, DECILE, N, DEFAULTS, MEAN_PD, OBSERVED_RATE, PD_MIN, PD_MAX,
                                           N_HOLDOUT, BRIER, BRIER_BASE, AUC, REGISTRY_AUC, COMPUTED_AT)
    SELECT :v, CAST(decile AS DECIMAL(2)), n, defaults, mean_pd, observed_rate, pd_min, pd_max, n_holdout, brier,
           brier_base, auc, :a, SYSTIMESTAMP
    FROM (SELECT CREDORA.PD_CALIBRATE(:mp, :mh, "loan_id", "gst_years", "gst_turnover_12m", "gst_late_filings_12m",
                                      "gst_bank_gap_pct", "avg_balance_12m", "inflow_volatility", "bounce_ratio",
                                      "cmr_rank", "partner_min_score", "partner_avg_score", "partner_overdue_amt",
                                      "partner_other_bank_bal", "dscr", "defaulted_flag" = 1)
          FROM VS_LOS."past_loan_training")]],
    {v = model_version, a = m[1].AUC, mp = m[1].MODEL_PATH, mh = m[1].MODEL_SHA256})
  return res
/

-- CREDORA.MODEL_PSI(run_id) replaces the PSI rows of one run. For each of the 13 model features it
-- takes ten bins from the past loans (the upper edge of bin k is the largest value in the k-th tenth,
-- the last bin is open), counts the past loans and the run's companies per bin, and sums
-- (live share - train share) * ln(live share / train share) over the bins. An empty share counts as
-- 0.0001, and a bin empty on both sides adds nothing. NULL live values (for example no GST returns on
-- file) are left out of the shares and counted in NULL_LIVE. BINS keeps the ten shares as JSON.
CREATE OR REPLACE LUA SCRIPT CREDORA.MODEL_PSI(run_id) RETURNS ROWCOUNT AS
  local features = {'gst_years', 'gst_turnover_12m', 'gst_late_filings_12m', 'gst_bank_gap_pct', 'avg_balance_12m',
                    'inflow_volatility', 'bounce_ratio', 'cmr_rank', 'partner_min_score', 'partner_avg_score',
                    'partner_overdue_amt', 'partner_other_bank_bal', 'dscr'}
  local live = query([[SELECT COUNT(*) N FROM CREDORA.FEATURES WHERE RUN_ID = :r]], {r = run_id})
  if live[1].N == 0 then error('Run ' .. run_id .. ' has no rows in CREDORA.FEATURES') end
  query([[DELETE FROM CREDORA.MODEL_PSI WHERE RUN_ID = :r]], {r = run_id})
  local written = 0
  for _, f in ipairs(features) do
    local train = 'SELECT CAST("' .. f .. '" AS DOUBLE) V FROM VS_LOS."past_loan_training"'
    local now = 'SELECT CAST(' .. string.upper(f) .. ' AS DOUBLE) V FROM CREDORA.FEATURES WHERE RUN_ID = :r'
    local edges = query([[
      SELECT B, MAX(V) HI
      FROM (SELECT V, NTILE(10) OVER (ORDER BY V) B FROM (]] .. train .. [[) WHERE V IS NOT NULL)
      GROUP BY B ORDER BY B]])
    if #edges == 0 then error('VS_LOS.past_loan_training has no rows to bin ' .. f) end
    local case = 'CASE'
    for i = 1, #edges - 1 do
      case = case .. ' WHEN V <= ' .. string.format('%.6f', edges[i].HI) .. ' THEN ' .. i
    end
    case = case .. ' ELSE ' .. #edges .. ' END'
    local bins = query([[
      SELECT B, SUM(T) N_TRAIN, SUM(L) N_LIVE FROM (
        SELECT ]] .. case .. [[ B, 1 T, 0 L FROM (]] .. train .. [[) WHERE V IS NOT NULL
        UNION ALL
        SELECT ]] .. case .. [[ B, 0 T, 1 L FROM (]] .. now .. [[) WHERE V IS NOT NULL)
      GROUP BY B ORDER BY B]], {r = run_id})
    local stats = query([[
      SELECT S, COUNT(*) N_ALL, COUNT(V) N, AVG(V) M
      FROM (SELECT 'T' S, V FROM (]] .. train .. [[) UNION ALL SELECT 'L' S, V FROM (]] .. now .. [[))
      GROUP BY S]], {r = run_id})
    local nt, nl, null_live, mt, ml = 0, 0, 0, null, null
    for _, s in ipairs(stats) do
      if s.S == 'T' then nt, mt = s.N, s.M else nl, null_live, ml = s.N, s.N_ALL - s.N, s.M end
    end
    local counts = {}
    for _, b in ipairs(bins) do counts[b.B] = {t = b.N_TRAIN, l = b.N_LIVE} end
    local psi, parts = 0, {}
    for k = 1, #edges do
      local c = counts[k] or {t = 0, l = 0}
      local pt = (nt > 0) and (c.t / nt) or 0
      local pl = (nl > 0) and (c.l / nl) or 0
      if c.t > 0 or c.l > 0 then
        local qt, ql = math.max(pt, 0.0001), math.max(pl, 0.0001)
        psi = psi + (ql - qt) * math.log(ql / qt)
      end
      local hi = (k < #edges) and string.format('%.6f', edges[k].HI) or 'null'
      parts[#parts + 1] = string.format('{"bin":%d,"hi":%s,"train":%.6f,"live":%.6f}', k, hi, pt, pl)
    end
    query([[
      INSERT INTO CREDORA.MODEL_PSI (RUN_ID, FEATURE, PSI, N_TRAIN, N_LIVE, NULL_LIVE, TRAIN_MEAN, LIVE_MEAN, BINS,
                                     COMPUTED_AT)
      VALUES (:r, :f, :p, :nt, :nl, :nn, :mt, :ml, :b, SYSTIMESTAMP)]],
      {r = run_id, f = f, p = psi, nt = nt, nl = nl, nn = null_live, mt = mt, ml = ml,
       b = '[' .. table.concat(parts, ',') .. ']'})
    written = written + 1
  end
  return written
/

-- The admin and the data scientist read the evidence (the schema grant in 07_security.sql covers
-- these tables too, and these lines keep the intent visible). CREDORA_SVC writes them and runs the
-- scripts through its schema grants.
GRANT SELECT ON CREDORA.MODEL_CALIBRATION TO R_ADMIN, R_DATASCI, R_LOANOPS;
GRANT SELECT ON CREDORA.MODEL_PSI TO R_ADMIN, R_DATASCI, R_LOANOPS;
