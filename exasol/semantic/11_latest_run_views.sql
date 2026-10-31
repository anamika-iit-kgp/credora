-- The latest analysis run, as views: what the Credora semantic model (12_credora_model.sql) reads.
--
-- Several runs are stored side by side and RUN_ID values do not sort by time. The latest run is
-- the newest run that finished all 13 steps of CREDORA.RUN_ANALYSIS without a failure (the step
-- count is backend/app/excerpts.py ANALYSIS_STEP_NAMES; runs from before the anomaly and challenger
-- steps ended with the ranking as step 11 and count as finished too). Every V_LATEST_* view holds exactly that
-- run, one row per company (APP_ID), so semantic metrics never mix runs and never need a run filter.
--
-- Only published runs count (CREDORA.RUN_PUBLISH, 13_rm_row_security.sql): a finished run is a
-- draft until the data scientist publishes it to loan operations, so the latest run here is the
-- newest finished run that is also published.
--
-- The views run with their owner's rights, so each role reads only the views it is granted below,
-- in line with 07_security.sql. Rows are filtered in Exasol: a relationship manager (role R_RM, see
-- CREDORA.V_SESSION_SCOPE) gets only the companies assigned to the logged-in Exasol user in
-- CREDORA.RM_ASSIGNMENT; every other role gets every company.

CREATE OR REPLACE VIEW CREDORA.V_LATEST_RUN AS
SELECT RUN_ID, FINISHED_AT FROM (
  SELECT l.RUN_ID, MAX(l.LOGGED_AT) FINISHED_AT
  FROM CREDORA.RUN_LOG l
  WHERE l.RUN_ID IN (SELECT RUN_ID FROM CREDORA.RUN_PUBLISH)
  GROUP BY l.RUN_ID
  HAVING SUM(CASE WHEN STATUS = 'FAILED' THEN 1 ELSE 0 END) = 0
     AND (MAX(STEP_NO) >= 13
          OR MAX(CASE WHEN STEP_NO = 11 AND STEP_NAME = 'Rank with PREFERRING skyline' THEN 1 ELSE 0 END) = 1)
) ORDER BY FINISHED_AT DESC, RUN_ID DESC LIMIT 1;

CREATE OR REPLACE VIEW CREDORA.V_LATEST_COMPANY AS
SELECT m.RUN_ID, m.APP_ID, m.CIF_ID, m.LEGAL_NAME, m.CONSTITUTION, m.INDUSTRY, m.CITY, m.STATE_NAME, m.RM_ID,
       m.PRODUCT, m.AMOUNT_REQUESTED, m.TENURE_REQUESTED, m.PURPOSE, m.PARTNERS, m.GST_STAGE, m.GST_YEARS
FROM CREDORA.V_COMPANY_MASKED m
JOIN CREDORA.V_LATEST_RUN r ON r.RUN_ID = m.RUN_ID
CROSS JOIN CREDORA.V_SESSION_SCOPE sc
WHERE NOT sc.IS_RM
   OR EXISTS (SELECT 1 FROM CREDORA.RM_ASSIGNMENT a WHERE a.CIF_ID = m.CIF_ID AND a.EXA_USER = sc.EXA_USER);

-- LGD_RATE is the policy loss-given-default (CONFIG LGD_PCT), so expected loss follows the policy knob.
CREATE OR REPLACE VIEW CREDORA.V_LATEST_DECISION AS
SELECT d.RUN_ID, d.APP_ID, d.CIF_ID, d.DECISION, d.HARD_FAILS, d.GRADE, d.PD, d.OFFER_AMOUNT, d.OFFER_ROI,
       d.OFFER_TENURE, d.FLOOR_ROI, d.MAX_AMOUNT, d.MAX_TENURE, d.RAROC_OFFER, d.RAROC_FLOOR, d.RANK_NO,
       d.SKYLINE_LAYER, d.TOP50, d.DECIDED_AT,
       COALESCE((SELECT CONFIG_VALUE FROM CREDORA.CONFIG WHERE CONFIG_KEY = 'LGD_PCT'), 45) / 100 LGD_RATE
FROM CREDORA.DECISIONS d
JOIN CREDORA.V_LATEST_RUN r ON r.RUN_ID = d.RUN_ID
CROSS JOIN CREDORA.V_SESSION_SCOPE sc
WHERE NOT sc.IS_RM
   OR EXISTS (SELECT 1 FROM CREDORA.RM_ASSIGNMENT a WHERE a.CIF_ID = d.CIF_ID AND a.EXA_USER = sc.EXA_USER);

CREATE OR REPLACE VIEW CREDORA.V_LATEST_SCORE AS
SELECT s.RUN_ID, s.APP_ID, s.MODEL_VERSION, s.PD, s.GRADE
FROM CREDORA.SCORES s
JOIN CREDORA.V_LATEST_RUN r ON r.RUN_ID = s.RUN_ID
CROSS JOIN CREDORA.V_SESSION_SCOPE sc
WHERE NOT sc.IS_RM
   OR EXISTS (SELECT 1 FROM CREDORA.DECISIONS d
              JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = d.CIF_ID
              WHERE a.EXA_USER = sc.EXA_USER AND d.RUN_ID = s.RUN_ID AND d.APP_ID = s.APP_ID);

CREATE OR REPLACE VIEW CREDORA.V_LATEST_FEATURE AS
SELECT f.RUN_ID, f.APP_ID, f.GST_TURNOVER_12M, f.GST_LATE_FILINGS_12M, f.GST_BANK_GAP_PCT,
       f.AVG_BALANCE_12M, f.INFLOW_VOLATILITY, f.BOUNCE_RATIO, f.CMR_RANK, f.PARTNER_MIN_SCORE, f.PARTNER_AVG_SCORE,
       f.PARTNER_OVERDUE_AMT, f.PARTNER_OTHER_BANK_BAL, f.DSCR, f.BANK_CREDITS_12M, f.WILFUL_DEFAULT, f.SUIT_FILED
FROM CREDORA.FEATURES f
JOIN CREDORA.V_LATEST_RUN r ON r.RUN_ID = f.RUN_ID
CROSS JOIN CREDORA.V_SESSION_SCOPE sc
WHERE NOT sc.IS_RM
   OR EXISTS (SELECT 1 FROM CREDORA.RM_ASSIGNMENT a WHERE a.CIF_ID = f.CIF_ID AND a.EXA_USER = sc.EXA_USER);

-- R_ADMIN, R_DATASCI and R_LOANOPS read all of schema CREDORA already (07_security.sql). A
-- relationship manager sees full detail of assigned companies, so R_RM gets the features view too.
GRANT SELECT ON CREDORA.V_LATEST_RUN TO R_MCP, R_RM;
GRANT SELECT ON CREDORA.V_LATEST_COMPANY TO R_MCP, R_RM;
GRANT SELECT ON CREDORA.V_LATEST_DECISION TO R_MCP, R_RM;
GRANT SELECT ON CREDORA.V_LATEST_SCORE TO R_MCP, R_RM;
GRANT SELECT ON CREDORA.V_LATEST_FEATURE TO R_MCP, R_RM;
