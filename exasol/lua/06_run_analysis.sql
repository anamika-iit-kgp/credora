-- CREDORA.TRAIN_MODEL(version): trains the champion and the challenger risk models on past loans
--   and registers both (activation needs the admin's approval: see the note in the script).
-- CREDORA.DECISION_LOGIC: the decision SQL, a library shared by RUN_ANALYSIS and SCORE_CHALLENGER.
-- CREDORA.SCORE_CHALLENGER(run_id): scores a run with the challenger model, shadow only.
-- CREDORA.RUN_ANALYSIS(run_id): the whole daily analysis in one call. Every step is logged to
-- CREDORA.RUN_LOG with its row count and duration, which the web app shows as "how Exasol decided".

CREATE OR REPLACE LUA SCRIPT CREDORA.TRAIN_MODEL(model_version) RETURNS ROWCOUNT AS
  -- Past loans are read live from PostgreSQL (los.past_loan) through the VS_LOS virtual schema.
  -- One call trains two models on the same loans and measures both on the same hold-out:
  --   <version>     the champion, gradient-boosted trees (TRAIN_PD)
  --   <version>-lr  the challenger, a logistic regression scorecard (TRAIN_SCORECARD), inactive
  -- The UPDATE below marks <version> active inside the caller's transaction. The web app runs this
  -- script with autocommit off and, in the same transaction, keeps the model that was active
  -- (backend/app/jobs.py _train): a new model decides only after the data scientist requests its
  -- activation and the admin approves it. The very first model stays active, so the first
  -- analysis has a model.
  local inputs = [["loan_id", "gst_years", "gst_turnover_12m", "gst_late_filings_12m", "gst_bank_gap_pct",
                   "avg_balance_12m", "inflow_volatility", "bounce_ratio", "cmr_rank",
                   "partner_min_score", "partner_avg_score", "partner_overdue_amt",
                   "partner_other_bank_bal", "dscr", "defaulted_flag" = 1]]
  -- Each trainer emits the SHA-256 of the pickle it uploaded. It is stored with the row, and PD_SCORE
  -- refuses a model file that no longer hashes to it.
  local columns = [[(MODEL_VERSION, TRAINED_AT, ALGORITHM, AUC, GINI, N_TRAIN, DEFAULT_RATE, FEATURE_IMPORTANCE,
                     MODEL_PATH, IS_ACTIVE, MODEL_SHA256)]]
  local res = query([[
    INSERT INTO CREDORA.MODEL_REGISTRY ]] .. columns .. [[
    SELECT model_version, SYSTIMESTAMP, algorithm, auc, gini, n_train, default_rate, feature_importance, model_path,
           FALSE, model_sha256
    FROM (SELECT CREDORA.TRAIN_PD(:v, ]] .. inputs .. [[) FROM VS_LOS."past_loan_training")]], {v = model_version})
  query([[
    INSERT INTO CREDORA.MODEL_REGISTRY ]] .. columns .. [[
    SELECT model_version, SYSTIMESTAMP, algorithm, auc, gini, n_train, default_rate, feature_importance, model_path,
           FALSE, model_sha256
    FROM (SELECT CREDORA.TRAIN_SCORECARD(:v, ]] .. inputs .. [[) FROM VS_LOS."past_loan_training")]],
    {v = model_version .. '-lr'})
  query([[UPDATE CREDORA.MODEL_REGISTRY SET IS_ACTIVE = (MODEL_VERSION = :v)]], {v = model_version})
  return res
/

-- The decision rule as one SQL statement, kept in one place. RUN_ANALYSIS step 11 runs it on the active
-- model's scores and writes CREDORA.DECISIONS; SCORE_CHALLENGER runs the very same SQL on the
-- challenger's scores to see which decisions would change. Only the scores table differs.
CREATE OR REPLACE LUA SCRIPT CREDORA.DECISION_LOGIC() AS
function decide(scores)
  local sql = [[
  WITH cfg AS (
    SELECT MAX(CASE WHEN CONFIG_KEY = 'EBLR_PCT' THEN CONFIG_VALUE END) EBLR,
           MAX(CASE WHEN CONFIG_KEY = 'OPERATING_SPREAD_PCT' THEN CONFIG_VALUE END) OPS,
           MAX(CASE WHEN CONFIG_KEY = 'FUNDS_COST_PCT' THEN CONFIG_VALUE END) FUNDS,
           MAX(CASE WHEN CONFIG_KEY = 'OPEX_PCT' THEN CONFIG_VALUE END) OPEX,
           MAX(CASE WHEN CONFIG_KEY = 'LGD_PCT' THEN CONFIG_VALUE END) LGD,
           MAX(CASE WHEN CONFIG_KEY = 'CAPITAL_PCT' THEN CONFIG_VALUE END) CAPITAL,
           MAX(CASE WHEN CONFIG_KEY = 'HURDLE_PCT' THEN CONFIG_VALUE END) HURDLE,
           MAX(CASE WHEN CONFIG_KEY = 'MAX_GST_SHARE_PCT' THEN CONFIG_VALUE END) GST_SHARE,
           MAX(CASE WHEN CONFIG_KEY = 'MIN_DSCR' THEN CONFIG_VALUE END) MIN_DSCR,
           MAX(CASE WHEN CONFIG_KEY = 'NEGOTIATION_DSCR' THEN CONFIG_VALUE END) NEG_DSCR,
           MAX(CASE WHEN CONFIG_KEY = 'FLOOR_MARGIN_PCT' THEN CONFIG_VALUE END) FLOOR_MARGIN
    FROM CREDORA.CONFIG),
  base AS (
    SELECT a.*, f.GST_TURNOVER_12M, f.GST_LATE_FILINGS_12M, f.BOUNCE_RATIO, f.CMR_RANK, f.PARTNER_MIN_SCORE,
           f.WILFUL_DEFAULT, s.PD, s.GRADE, an.TOP_REASONS ANOMALY, cfg.*,
           f.GST_TURNOVER_12M * 0.12 CASH,
           CASE s.GRADE WHEN 'A1' THEN 1.00 WHEN 'A2' THEN 1.50 WHEN 'B1' THEN 2.25 WHEN 'B2' THEN 3.00
                        WHEN 'C1' THEN 4.00 WHEN 'C2' THEN 5.25 ELSE 7.00 END RISK_SPREAD,
           CASE WHEN a.COLLATERAL_VALUE >= a.AMOUNT_REQUESTED THEN 0.25 ELSE 0 END COLLATERAL_DISCOUNT,
           CASE WHEN a.PRODUCT = 'TL'
                THEN LEAST(a.TENURE_REQUESTED, CASE WHEN s.GRADE IN ('C1', 'C2', 'D') THEN 60 ELSE 84 END)
                ELSE 12 END TENURE_OFFER
    FROM CREDORA.APPLICATIONS a
    JOIN CREDORA.FEATURES f ON f.APP_ID = a.APP_ID AND f.RUN_ID = a.RUN_ID
    JOIN CREDORA.SCORES s ON s.APP_ID = a.APP_ID AND s.RUN_ID = a.RUN_ID
    LEFT JOIN CREDORA.ANOMALY an ON an.APP_ID = a.APP_ID AND an.RUN_ID = a.RUN_ID AND an.IS_ANOMALY
    CROSS JOIN cfg
    WHERE a.RUN_ID = :r),
  priced AS (
    SELECT b.*,
           CEIL((GREATEST(EBLR + FLOOR_MARGIN, HURDLE * CAPITAL / 100 + FUNDS + OPEX + PD * LGD)) * 20) / 20 FLOOR_ROI_RAW,
           EBLR + RISK_SPREAD + OPS - COLLATERAL_DISCOUNT LIST_ROI,
           CASE WHEN PRODUCT = 'TL' THEN LEAST(84, TENURE_OFFER + 24) ELSE 12 END TENURE_MAX
    FROM base b),
  sized AS (
    SELECT p.*, GREATEST(LIST_ROI, FLOOR_ROI_RAW) OFFER_ROI_RAW,
           CASE WHEN PRODUCT = 'TL'
                THEN CASH / MIN_DSCR / 12 * (1 - POWER(1 + GREATEST(LIST_ROI, FLOOR_ROI_RAW) / 1200, -TENURE_OFFER))
                     / (GREATEST(LIST_ROI, FLOOR_ROI_RAW) / 1200)
                ELSE LEAST(GST_TURNOVER_12M * GST_SHARE / 100, CASH / MIN_DSCR / (GREATEST(LIST_ROI, FLOOR_ROI_RAW) / 100))
           END CAP_OFFER,
           CASE WHEN PRODUCT = 'TL'
                THEN CASH / NEG_DSCR / 12 * (1 - POWER(1 + FLOOR_ROI_RAW / 1200, -TENURE_MAX)) / (FLOOR_ROI_RAW / 1200)
                ELSE LEAST(GST_TURNOVER_12M * (GST_SHARE + 5) / 100, CASH / NEG_DSCR / (FLOOR_ROI_RAW / 100))
           END CAP_MAX
    FROM priced p),
  judged AS (
    SELECT s.*,
           FLOOR(LEAST(AMOUNT_REQUESTED, GREATEST(CAP_OFFER, 0)) / 100000) * 100000 OFFER_AMT,
           FLOOR(LEAST(AMOUNT_REQUESTED * 1.15, GREATEST(CAP_MAX, 0)) / 100000) * 100000 MAX_AMT,
           NULLIF(TRIM(BOTH ';' FROM
             CASE WHEN WILFUL_DEFAULT THEN 'Wilful defaulter;' ELSE '' END ||
             CASE WHEN CMR_RANK >= 9 THEN 'CIBIL CMR rank ' || CMR_RANK || ';' ELSE '' END ||
             CASE WHEN GST_LATE_FILINGS_12M IS NOT NULL AND GST_LATE_FILINGS_12M >= 4
                  THEN GST_LATE_FILINGS_12M || ' late GST returns in 12 months;' ELSE '' END ||
             CASE WHEN PARTNER_MIN_SCORE < 600 THEN 'Partner CIBIL ' || PARTNER_MIN_SCORE || ' below 600;' ELSE '' END ||
             CASE WHEN BOUNCE_RATIO > 0.08 THEN 'Bounce ratio ' || ROUND(BOUNCE_RATIO * 100, 1) || '%;' ELSE '' END), '') FAILS
    FROM sized s)
  SELECT :r, APP_ID, CIF_ID, LEGAL_NAME, RM_ID, PRODUCT, AMOUNT_REQUESTED, TENURE_REQUESTED,
         CASE WHEN FAILS IS NOT NULL THEN 'DECLINE'
              WHEN KYC_STATUS <> 'VERIFIED' OR GST_TURNOVER_12M = 0 OR GST_LATE_FILINGS_12M IS NULL  -- no GST returns on file means a person looks first, never a decline
                   OR GRADE IN ('C2', 'D') OR OFFER_AMT < AMOUNT_REQUESTED * 0.5
                   OR FLOOR_ROI_RAW > LIST_ROI
                   OR OFFER_AMT <= 0 THEN 'REFER'
              WHEN ANOMALY IS NOT NULL THEN 'REFER'  -- unusual figures: a person looks first; never a decline
              ELSE 'APPROVE' END DECISION,
         NULLIF(TRIM(BOTH ';' FROM COALESCE(FAILS, '') ||
                CASE WHEN KYC_STATUS <> 'VERIFIED' THEN ';KYC ' || KYC_STATUS ELSE '' END ||
                CASE WHEN GST_TURNOVER_12M = 0 OR GST_LATE_FILINGS_12M IS NULL THEN ';No GST returns on file' ELSE '' END ||
                CASE WHEN FLOOR_ROI_RAW > LIST_ROI THEN ';Hurdle needs ROI above rate card' ELSE '' END ||
                CASE WHEN ANOMALY IS NOT NULL THEN ';Anomaly: ' || ANOMALY ELSE '' END), '') HARD_FAILS,
         GRADE, PD,
         CASE WHEN FAILS IS NULL THEN OFFER_AMT END, CASE WHEN FAILS IS NULL THEN OFFER_ROI_RAW END,
         CASE WHEN FAILS IS NULL THEN TENURE_OFFER END, CASE WHEN FAILS IS NULL THEN FLOOR_ROI_RAW END,
         CASE WHEN FAILS IS NULL THEN GREATEST(MAX_AMT, OFFER_AMT) END, CASE WHEN FAILS IS NULL THEN TENURE_MAX END,
         ROUND((OFFER_ROI_RAW - FUNDS - OPEX - PD * LGD) / CAPITAL * 100, 3),
         ROUND((FLOOR_ROI_RAW - FUNDS - OPEX - PD * LGD) / CAPITAL * 100, 3)
  FROM judged]]
  local i, j = string.find(sql, 'CREDORA.SCORES', 1, true)
  return string.sub(sql, 1, i - 1) .. scores .. string.sub(sql, j + 1)
end
/

-- CREDORA.SCORE_CHALLENGER(run_id): champion/challenger, shadow only. Scores one run's companies with
-- the challenger (the newest model of another algorithm than the active one) and stores the PD, the
-- grade and the decision it would have given. CREDORA.DECISIONS is never touched: the challenger
-- decides only after the admin approves its activation (MODEL_REGISTRY.IS_ACTIVE).
CREATE OR REPLACE LUA SCRIPT CREDORA.SCORE_CHALLENGER(run_id) RETURNS ROWCOUNT AS
import('CREDORA.DECISION_LOGIC', 'logic')
local p = {r = run_id}
local cleared = query([[DELETE FROM CREDORA.CHALLENGER_SCORES WHERE RUN_ID = :r]], p)
local ch = query([[
  SELECT MODEL_VERSION, MODEL_PATH, MODEL_SHA256 FROM CREDORA.MODEL_REGISTRY
  WHERE NOT IS_ACTIVE AND ALGORITHM <> (SELECT MAX(ALGORITHM) FROM CREDORA.MODEL_REGISTRY WHERE IS_ACTIVE)
  ORDER BY TRAINED_AT DESC LIMIT 1]])
if #ch == 0 then return cleared end  -- no challenger trained yet
local res = query([[
  INSERT INTO CREDORA.CHALLENGER_SCORES (RUN_ID, APP_ID, MODEL_VERSION, PD, GRADE)
  SELECT :r, app_id, :mv, pd,
         CASE WHEN pd < 0.01 THEN 'A1' WHEN pd < 0.02 THEN 'A2' WHEN pd < 0.035 THEN 'B1' WHEN pd < 0.05 THEN 'B2'
              WHEN pd < 0.08 THEN 'C1' WHEN pd < 0.12 THEN 'C2' ELSE 'D' END
  FROM (SELECT CREDORA.PD_SCORE(:mp, :mh, APP_ID, GST_YEARS, GST_TURNOVER_12M, GST_LATE_FILINGS_12M, GST_BANK_GAP_PCT,
                                AVG_BALANCE_12M, INFLOW_VOLATILITY, BOUNCE_RATIO, CMR_RANK, PARTNER_MIN_SCORE,
                                PARTNER_AVG_SCORE, PARTNER_OVERDUE_AMT, PARTNER_OTHER_BANK_BAL, DSCR)
        FROM CREDORA.FEATURES WHERE RUN_ID = :r GROUP BY MOD(ASCII(SUBSTR(HASH_MD5(APP_ID), 1, 1)), 4))]],
  {r = run_id, mv = ch[1].MODEL_VERSION, mp = ch[1].MODEL_PATH, mh = ch[1].MODEL_SHA256})
-- The decision it would have given: the decision step's own SQL, fed the challenger's PD and grade.
query([[
  MERGE INTO CREDORA.CHALLENGER_SCORES c
  USING (]] .. logic.decide('CREDORA.CHALLENGER_SCORES') .. [[) d
  ON c.RUN_ID = :r AND c.APP_ID = d.APP_ID
  WHEN MATCHED THEN UPDATE SET DECISION = d.DECISION]], p)
return res
/

CREATE OR REPLACE LUA SCRIPT CREDORA.RUN_ANALYSIS(run_id) RETURNS TABLE AS

import('CREDORA.DECISION_LOGIC', 'logic')

local function now()
  return query([[SELECT TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS.FF3') T FROM DUAL]])[1].T
end

local function log(no, name, status, rows, t0, detail)
  query([[INSERT INTO CREDORA.RUN_LOG (RUN_ID, STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS, DETAIL)
          VALUES (:r, :n, :s, :st, :rows,
                  ROUND(SECONDS_BETWEEN(SYSTIMESTAMP, TO_TIMESTAMP(:t0, 'YYYY-MM-DD HH24:MI:SS.FF3')) * 1000), :d)]],
        {r = run_id, n = no, s = name, st = status, rows = rows, t0 = t0, d = detail})
end

local function step(no, name, fn)
  local t0 = now()
  local ok, res = pcall(fn)
  if ok then
    log(no, name, 'OK', res or 0, t0, null)
    query('COMMIT')  -- make each finished step visible to the web app at once
  else
    -- The failing step's half-done work goes back, as before. The FAILED row then gets its own
    -- commit, because error() makes Exasol roll back everything this script has not committed,
    -- which took the FAILED row with it and left the web app (backend/app/jobs.py) nothing to show.
    pquery('ROLLBACK')
    log(no, name, 'FAILED', 0, t0, string.sub(tostring(res), 1, 1900))
    query('COMMIT')
    error(res)
  end
end

local function rows(res) return res.rows_affected or 0 end

local p = {r = run_id}

for _, t in ipairs({'APPLICATIONS', 'FEATURES', 'SCORES', 'ANOMALY', 'DECISIONS', 'CHALLENGER_SCORES'}) do
  query('DELETE FROM CREDORA.' .. t .. ' WHERE RUN_ID = :r', p)
end
query('DELETE FROM CREDORA.RUN_LOG WHERE RUN_ID = :r', p)

-- 1. Virtual schemas cache source metadata; refresh so new or regenerated tables are seen.
step(1, 'Refresh virtual schemas', function()
  for _, vs in ipairs({'VS_CBS', 'VS_CIF', 'VS_LOS'}) do
    query('ALTER VIRTUAL SCHEMA ' .. vs .. ' REFRESH')
  end
  return 3
end)

-- 2. Applications (PostgreSQL) joined with the customer master (MySQL), in place.
step(2, 'Read credit needs on file', function()
  return rows(query([[
    INSERT INTO CREDORA.APPLICATIONS
    SELECT :r, a."app_id", a."cif_id", c."legal_name", c."constitution", c."pan", c."gstin", c."industry",
           c."city", c."state", c."rm_id", c."kyc_status", a."applied_on", a."product", a."amount_requested",
           a."tenure_requested", a."purpose", a."collateral_type", a."collateral_value", p.n
    FROM VS_LOS."application" a
    JOIN VS_CIF."company" c ON c."cif_id" = a."cif_id"
    LEFT JOIN (SELECT "cif_id", COUNT(*) n FROM VS_CIF."partner" GROUP BY "cif_id") p ON p."cif_id" = a."cif_id"]], p))
end)

-- 3-6. 3rd party data fetched via API by the API UDFs. Keys are spread over 16 batches (one hex digit
--      of an MD5), and Exasol runs the UDF instances 4 at a time on the 4-core node.
step(3, 'Fetch CIBIL consumer reports (API)', function()
  query('DELETE FROM CREDORA_STAGE.CIBIL_CONSUMER WHERE RUN_ID = :r', p)
  return rows(query([[
    INSERT INTO CREDORA_STAGE.CIBIL_CONSUMER
    SELECT :r, pan, name, score, enquiries_6m, enquiries_12m, accounts, active_accounts, total_sanctioned,
           total_balance, total_overdue, max_dpd_12m, max_dpd_36m, written_off, SYSTIMESTAMP,
           ADD_DAYS(SYSTIMESTAMP, 7), raw_json
    FROM (SELECT CREDORA.CIBIL_CONSUMER_FETCH('MOCK_CIBIL', pan)
          FROM (SELECT DISTINCT p."pan" pan, SUBSTR(HASH_MD5(p."pan"), 1, 1) b
                FROM VS_CIF."partner" p JOIN CREDORA.APPLICATIONS a ON a.CIF_ID = p."cif_id" AND a.RUN_ID = :r)
          GROUP BY b)]], p))
end)

step(4, 'Fetch CIBIL commercial reports (API)', function()
  query('DELETE FROM CREDORA_STAGE.CIBIL_COMMERCIAL WHERE RUN_ID = :r', p)
  return rows(query([[
    INSERT INTO CREDORA_STAGE.CIBIL_COMMERCIAL
    SELECT :r, pan, name, cmr_rank, total_exposure, overdue, suit_filed, wilful_default, facilities,
           SYSTIMESTAMP, ADD_DAYS(SYSTIMESTAMP, 7), raw_json
    FROM (SELECT CREDORA.CIBIL_COMMERCIAL_FETCH('MOCK_CIBIL', pan)
          FROM (SELECT DISTINCT PAN pan, SUBSTR(HASH_MD5(PAN), 1, 1) b FROM CREDORA.APPLICATIONS WHERE RUN_ID = :r)
          GROUP BY b)]], p))
end)

step(5, 'Fetch GST returns (API)', function()
  query('DELETE FROM CREDORA_STAGE.GST_FILING WHERE RUN_ID = :r', p)
  return rows(query([[
    INSERT INTO CREDORA_STAGE.GST_FILING
    SELECT :r, gstin, legal_name, pan, state_name, registered_on, reg_status, stage, gst_period, gstr1_turnover,
           gstr3b_tax_paid, due_date, filed_on, delay_days, SYSTIMESTAMP, ADD_DAYS(SYSTIMESTAMP, 7)
    FROM (SELECT CREDORA.GST_FETCH('MOCK_GSTN', gstin)
          FROM (SELECT DISTINCT GSTIN gstin, SUBSTR(HASH_MD5(GSTIN), 1, 1) b FROM CREDORA.APPLICATIONS WHERE RUN_ID = :r)
          GROUP BY b)]], p))
end)

step(6, 'Fetch partner accounts at other banks (Account Aggregator API)', function()
  query('DELETE FROM CREDORA_STAGE.AA_ACCOUNT WHERE RUN_ID = :r', p)
  return rows(query([[
    INSERT INTO CREDORA_STAGE.AA_ACCOUNT
    SELECT :r, pan, consent_id, consent_expires, aa_account_id, fip, acct_type, masked_no, opened_on,
           current_balance, txn_count, credits_12m, debits_12m, SYSTIMESTAMP,
           COALESCE(consent_expires, ADD_HOURS(SYSTIMESTAMP, 24))
    FROM (SELECT CREDORA.AA_FETCH('MOCK_AA', pan, CURRENT_DATE)
          FROM (SELECT DISTINCT p."pan" pan, SUBSTR(HASH_MD5(p."pan"), 1, 1) b
                FROM VS_CIF."partner" p JOIN CREDORA.APPLICATIONS a ON a.CIF_ID = p."cif_id" AND a.RUN_ID = :r)
          GROUP BY b)]], p))
end)

-- 7. Features, exactly as defined in docs/DATA_MODEL.md section 8. Bank transactions are
--    aggregated per account and month in Oracle (pushdown through VS_CBS): the join, the filter
--    and the GROUP BY all run inside Oracle, so ~19,000 monthly rows cross the network instead of
--    ~850,000 transactions. The month is grouped as TO_CHAR(TXN_DATE, 'YYYY-MM') because the Oracle
--    adapter pushes TO_CHAR but not TRUNC(date, 'MM'); EXPLAIN VIRTUAL shows the SQL Oracle gets.
step(7, 'Compute features', function()
  query([[DELETE FROM CREDORA_STAGE.CA_MONTHLY]])
  query([[INSERT INTO CREDORA_STAGE.CA_MONTHLY
          SELECT m.ACCOUNT_NO, m.CIF_ID, TO_TIMESTAMP(m.MON || '-01', 'YYYY-MM-DD'), m.CREDITS, m.DEBITS,
                 m.BOUNCES, m.BAL_SUM, m.N
          FROM (SELECT t.ACCOUNT_NO, a.OWNER_ID CIF_ID, TO_CHAR(t.TXN_DATE, 'YYYY-MM') MON,
                       SUM(CASE WHEN t.DR_CR = 'C' THEN t.AMOUNT ELSE 0 END) CREDITS,
                       SUM(CASE WHEN t.DR_CR = 'D' THEN 1 ELSE 0 END) DEBITS,
                       SUM(CASE WHEN t.BOUNCED = 'Y' THEN 1 ELSE 0 END) BOUNCES,
                       SUM(t.BALANCE_AFTER) BAL_SUM, COUNT(*) N
                FROM VS_CBS.TXN t JOIN VS_CBS.ACCOUNT a ON a.ACCOUNT_NO = t.ACCOUNT_NO
                WHERE a.OWNER_TYPE = 'COMPANY' AND a.ACCT_TYPE = 'CA'
                GROUP BY t.ACCOUNT_NO, a.OWNER_ID, TO_CHAR(t.TXN_DATE, 'YYYY-MM')) m]])
  return rows(query([[
    INSERT INTO CREDORA.FEATURES
    WITH app AS (
      SELECT a.*, ADD_MONTHS(TRUNC(APPLIED_ON, 'MM'), -12) WIN_START, TRUNC(APPLIED_ON, 'MM') WIN_END,
             TO_CHAR(APPLIED_ON, 'YYYY-MM') AS_OF_PERIOD
      FROM CREDORA.APPLICATIONS a WHERE RUN_ID = :r),
    bank AS (
      SELECT app.APP_ID, SUM(m.CREDITS) CREDITS_12M, SUM(m.BAL_SUM) / NULLIF(SUM(m.N), 0) AVG_BAL,
             SUM(m.BOUNCES) / NULLIF(SUM(m.DEBITS), 0) BOUNCE_RATIO,
             SQRT(GREATEST(SUM(m.CREDITS * m.CREDITS) / 12 - POWER(SUM(m.CREDITS) / 12, 2), 0))
               / NULLIF(SUM(m.CREDITS) / 12, 0) VOLATILITY
      FROM app JOIN CREDORA_STAGE.CA_MONTHLY m
        ON m.CIF_ID = app.CIF_ID AND m.MON >= app.WIN_START AND m.MON < app.WIN_END
      GROUP BY app.APP_ID),
    gst_ranked AS (
      SELECT app.APP_ID, g.*, ROW_NUMBER() OVER (PARTITION BY app.APP_ID ORDER BY g.GST_PERIOD DESC) RN
      FROM app JOIN CREDORA_STAGE.GST_FILING g ON g.GSTIN = app.GSTIN AND g.RUN_ID = :r
      WHERE g.GST_PERIOD < app.AS_OF_PERIOD),
    gst AS (
      SELECT APP_ID, SUM(GSTR1_TURNOVER) TURNOVER,
             SUM(CASE WHEN FILED_ON IS NULL OR FILED_ON > DUE_DATE THEN 1 ELSE 0 END) LATE,
             MAX(REGISTERED_ON) REGISTERED_ON, MAX(STAGE) STAGE
      FROM gst_ranked WHERE RN <= 12 GROUP BY APP_ID),
    partners AS (
      SELECT app.APP_ID,
             MIN(CASE WHEN c.SCORE = -1 THEN 650 ELSE c.SCORE END) MIN_SCORE,
             ROUND(AVG(CASE WHEN c.SCORE = -1 THEN 650 ELSE c.SCORE END), 1) AVG_SCORE,
             SUM(c.TOTAL_OVERDUE) OVERDUE
      FROM app JOIN VS_CIF."partner" pt ON pt."cif_id" = app.CIF_ID
      JOIN CREDORA_STAGE.CIBIL_CONSUMER c ON c.PAN = pt."pan" AND c.RUN_ID = :r
      GROUP BY app.APP_ID),
    aa AS (
      SELECT app.APP_ID, SUM(x.CURRENT_BALANCE) BAL
      FROM app JOIN VS_CIF."partner" pt ON pt."cif_id" = app.CIF_ID
      JOIN CREDORA_STAGE.AA_ACCOUNT x ON x.PAN = pt."pan" AND x.RUN_ID = :r
      GROUP BY app.APP_ID)
    SELECT :r, app.APP_ID, app.CIF_ID,
           ROUND(((YEAR(app.APPLIED_ON) * 12 + MONTH(app.APPLIED_ON))
                  - (YEAR(gst.REGISTERED_ON) * 12 + MONTH(gst.REGISTERED_ON))) / 12, 1),
           -- GST_LATE_FILINGS_12M stays NULL when no GST returns are on file, so the decision step
           -- refers the company instead of declining it (PD_SCORE fills the NULL from its baseline).
           COALESCE(gst.TURNOVER, 0), gst.LATE,
           ABS(COALESCE(gst.TURNOVER, 0) - COALESCE(bank.CREDITS_12M, 0)) / NULLIF(gst.TURNOVER, 0) * 100,
           bank.AVG_BAL, bank.VOLATILITY, COALESCE(bank.BOUNCE_RATIO, 0), com.CMR_RANK,
           partners.MIN_SCORE, partners.AVG_SCORE, COALESCE(partners.OVERDUE, 0), COALESCE(aa.BAL, 0),
           COALESCE(gst.TURNOVER, 0) * 0.12 /
             CASE WHEN app.PRODUCT = 'TL'
                  THEN 12 * app.AMOUNT_REQUESTED * (0.11 / 12) / (1 - POWER(1 + 0.11 / 12, -app.TENURE_REQUESTED))
                  ELSE app.AMOUNT_REQUESTED * 0.11 END,
           bank.CREDITS_12M, com.WILFUL_DEFAULT, com.SUIT_FILED, gst.STAGE
    FROM app
    LEFT JOIN bank ON bank.APP_ID = app.APP_ID
    LEFT JOIN gst ON gst.APP_ID = app.APP_ID
    LEFT JOIN partners ON partners.APP_ID = app.APP_ID
    LEFT JOIN aa ON aa.APP_ID = app.APP_ID
    LEFT JOIN CREDORA_STAGE.CIBIL_COMMERCIAL com ON com.PAN = app.PAN AND com.RUN_ID = :r]], p))
end)

-- 8. Make sure a risk model exists; train the first one on past loans if needed.
local active = query([[SELECT MODEL_VERSION, MODEL_PATH, MODEL_SHA256 FROM CREDORA.MODEL_REGISTRY WHERE IS_ACTIVE]])
step(8, 'Risk model', function()
  if #active == 0 then
    local v = 'v' .. (query([[SELECT COUNT(*) N FROM CREDORA.MODEL_REGISTRY]])[1].N + 1)
    query([[EXECUTE SCRIPT CREDORA.TRAIN_MODEL(:v)]], {v = v})
    active = query([[SELECT MODEL_VERSION, MODEL_PATH, MODEL_SHA256 FROM CREDORA.MODEL_REGISTRY WHERE IS_ACTIVE]])
  end
  return 1
end)
local model_version, model_path, model_sha256 = active[1].MODEL_VERSION, active[1].MODEL_PATH, active[1].MODEL_SHA256

-- 9. Score every application with the ML UDF, in 4 parallel instances (one per core).
step(9, 'Score probability of default (ML UDF)', function()
  return rows(query([[
    INSERT INTO CREDORA.SCORES
    SELECT :r, app_id, :mv, pd,
           CASE WHEN pd < 0.01 THEN 'A1' WHEN pd < 0.02 THEN 'A2' WHEN pd < 0.035 THEN 'B1' WHEN pd < 0.05 THEN 'B2'
                WHEN pd < 0.08 THEN 'C1' WHEN pd < 0.12 THEN 'C2' ELSE 'D' END,
           contributions
    FROM (SELECT CREDORA.PD_SCORE(:mp, :mh, APP_ID, GST_YEARS, GST_TURNOVER_12M, GST_LATE_FILINGS_12M, GST_BANK_GAP_PCT,
                                  AVG_BALANCE_12M, INFLOW_VOLATILITY, BOUNCE_RATIO, CMR_RANK, PARTNER_MIN_SCORE,
                                  PARTNER_AVG_SCORE, PARTNER_OVERDUE_AMT, PARTNER_OTHER_BANK_BAL, DSCR)
          FROM CREDORA.FEATURES WHERE RUN_ID = :r GROUP BY MOD(ASCII(SUBSTR(HASH_MD5(APP_ID), 1, 1)), 4))]],
    {r = run_id, mv = model_version, mp = model_path, mh = model_sha256}))
end)

-- 10. Anomaly flag: an Isolation Forest over this run's features, in one UDF instance that sees every
--     company. Flagged companies are referred in step 11 with the reason, never declined on it.
step(10, 'Flag anomalies (Isolation Forest UDF)', function()
  return rows(query([[
    INSERT INTO CREDORA.ANOMALY
    SELECT :r, app_id, score, is_anomaly, top_reasons
    FROM (SELECT CREDORA.ANOMALY_FLAG(f.APP_ID, c.CONFIG_VALUE, f.GST_TURNOVER_12M, f.BANK_CREDITS_12M,
                                      f.AVG_BALANCE_12M, f.INFLOW_VOLATILITY, f.PARTNER_OTHER_BANK_BAL)
          FROM CREDORA.FEATURES f
          LEFT JOIN CREDORA.CONFIG c ON c.CONFIG_KEY = 'ANOMALY_CONTAMINATION_PCT'
          WHERE f.RUN_ID = :r)]], p))
end)

-- 11. Decide: eligible amount, price, return, negotiation limit, decision. The SQL is the
--     CREDORA.DECISION_LOGIC library, on the active model's scores.
step(11, 'Decide offer and negotiation limit', function()
  return rows(query([[
    INSERT INTO CREDORA.DECISIONS (RUN_ID, APP_ID, CIF_ID, LEGAL_NAME, RM_ID, PRODUCT, AMOUNT_REQUESTED,
      TENURE_REQUESTED, DECISION, HARD_FAILS, GRADE, PD, OFFER_AMOUNT, OFFER_ROI, OFFER_TENURE, FLOOR_ROI,
      MAX_AMOUNT, MAX_TENURE, RAROC_OFFER, RAROC_FLOOR)
    ]] .. logic.decide('CREDORA.SCORES'), p))
end)

-- 12. Rank. PREFERRING returns the skyline: companies no other company beats on return, risk
--     and amount at once. Peeling off skyline after skyline gives layers; the best 50 go to RMs.
step(12, 'Rank with PREFERRING skyline', function()
  local layer, ranked = 0, 0
  while ranked < 50 and layer < 30 do
    layer = layer + 1
    local res = query([[
      UPDATE CREDORA.DECISIONS SET SKYLINE_LAYER = :l
      WHERE RUN_ID = :r AND APP_ID IN (
        SELECT APP_ID FROM CREDORA.DECISIONS
        WHERE RUN_ID = :r AND DECISION = 'APPROVE' AND SKYLINE_LAYER IS NULL
        PREFERRING HIGH RAROC_OFFER PLUS LOW PD PLUS HIGH OFFER_AMOUNT)]], {r = run_id, l = layer})
    if rows(res) == 0 then break end
    ranked = ranked + rows(res)
  end
  query([[
    MERGE INTO CREDORA.DECISIONS d USING (
      SELECT APP_ID, ROW_NUMBER() OVER (ORDER BY CASE DECISION WHEN 'APPROVE' THEN 1 WHEN 'REFER' THEN 2 ELSE 3 END,
                                                 COALESCE(SKYLINE_LAYER, 999), PD, RAROC_OFFER DESC) RN
      FROM CREDORA.DECISIONS WHERE RUN_ID = :r) x
    ON d.APP_ID = x.APP_ID AND d.RUN_ID = :r
    WHEN MATCHED THEN UPDATE SET RANK_NO = x.RN, TOP50 = (x.RN <= 50 AND d.DECISION = 'APPROVE')]], p)
  return ranked
end)

-- 13. Champion/challenger: the same companies scored by the challenger model, with the decisions it
--     would have given. Shadow only; it decides nothing until a data scientist activates it.
step(13, 'Shadow-score with the challenger model', function()
  return rows(query([[EXECUTE SCRIPT CREDORA.SCORE_CHALLENGER(:r)]], p))
end)

local summary = query([[SELECT DECISION, COUNT(*) N FROM CREDORA.DECISIONS WHERE RUN_ID = :r GROUP BY DECISION]], p)
local out = {}
for i = 1, #summary do out[i] = {summary[i].DECISION, summary[i].N} end
exit(out, "decision VARCHAR(8), n DECIMAL(10)")
/
