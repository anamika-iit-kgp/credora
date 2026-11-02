-- Fixture rows for the docker-db check (tests/exasol/run_docker_db.py): one analysis run of 50
-- synthetic companies, CI-RUN-1, as steps 2 to 10 of CREDORA.RUN_ANALYSIS would leave it. Those
-- steps read the virtual schemas, call the API UDFs and load a model file from BucketFS, none of
-- which a throwaway docker-db has, so these rows stand in for their output. The decision SQL of
-- CREDORA.DECISION_LOGIC and the PREFERRING ranking then run on them for real (ci_scripts.sql).
--
-- Every value is arithmetic on the company number n, so the run is the same on every machine:
--   n divisible by 10  wilful defaulter              DECLINE, a hard fail
--   n ending in 5      KYC pending                   REFER
--   n = 7              flagged by the anomaly check  REFER, never a decline
--   the other 39       APPROVE, all in the Top 50
-- Companies 1, 2, 3, 4 and 6 are assigned to the second relationship manager (CREDORA_RM002)
-- before the seed in exasol/sql/14_seed_rm_book.sql gives CREDORA_RM its book, so the two books
-- never overlap. The staging tables get rows whose purge time has passed and rows whose purge time
-- is ahead, for the purge round trip, plus an older run CI-RUN-0 that has expired as a whole. Its
-- GST rows number more than 1,000, so PURGE_EXPIRED fingerprints it in more than one chunk.
-- Applied as CREDORA_SVC, the user that writes these tables in production.

INSERT INTO CREDORA.APPLICATIONS (RUN_ID, APP_ID, CIF_ID, LEGAL_NAME, CONSTITUTION, PAN, GSTIN, INDUSTRY, CITY,
  STATE_NAME, RM_ID, KYC_STATUS, APPLIED_ON, PRODUCT, AMOUNT_REQUESTED, TENURE_REQUESTED, PURPOSE,
  COLLATERAL_TYPE, COLLATERAL_VALUE, PARTNERS)
SELECT 'CI-RUN-1', 'A' || LPAD(n, 5, '0'), 'C' || LPAD(n, 5, '0'), 'Fixture Company ' || n || ' Pvt Ltd',
       CASE MOD(n, 3) WHEN 0 THEN 'PRIVATE_LTD' WHEN 1 THEN 'PARTNERSHIP' ELSE 'LLP' END,
       'AAACF' || LPAD(n, 4, '0') || 'A',
       '27AAACF' || LPAD(n, 4, '0') || 'A1Z5',
       CASE MOD(n, 4) WHEN 0 THEN 'Textiles' WHEN 1 THEN 'Pharma' WHEN 2 THEN 'Auto components' ELSE 'Logistics' END,
       CASE MOD(n, 4) WHEN 0 THEN 'Surat' WHEN 1 THEN 'Hyderabad' WHEN 2 THEN 'Pune' ELSE 'Nagpur' END,
       CASE MOD(n, 4) WHEN 0 THEN 'Gujarat' WHEN 1 THEN 'Telangana' ELSE 'Maharashtra' END,
       CASE WHEN MOD(n, 2) = 0 THEN 'RM002' ELSE 'RM001' END,
       CASE WHEN MOD(n, 10) = 5 THEN 'PENDING' ELSE 'VERIFIED' END,
       ADD_DAYS(DATE '2026-10-01', MOD(n, 20)),
       CASE WHEN MOD(n, 2) = 0 THEN 'WC' ELSE 'TL' END,
       2500000 + n * 100000,
       CASE WHEN MOD(n, 2) = 0 THEN 12 ELSE 36 END,
       CASE WHEN MOD(n, 2) = 0 THEN 'Working capital for the festive season' ELSE 'New machinery' END,
       CASE WHEN MOD(n, 3) = 0 THEN 'Property' ELSE 'None' END,
       CASE WHEN MOD(n, 3) = 0 THEN 3000000 + n * 150000 ELSE 0 END,
       1 + MOD(n, 3)
FROM (SELECT LEVEL n FROM DUAL CONNECT BY LEVEL <= 50);

INSERT INTO CREDORA.FEATURES (RUN_ID, APP_ID, CIF_ID, GST_YEARS, GST_TURNOVER_12M, GST_LATE_FILINGS_12M,
  GST_BANK_GAP_PCT, AVG_BALANCE_12M, INFLOW_VOLATILITY, BOUNCE_RATIO, CMR_RANK, PARTNER_MIN_SCORE,
  PARTNER_AVG_SCORE, PARTNER_OVERDUE_AMT, PARTNER_OTHER_BANK_BAL, DSCR, BANK_CREDITS_12M, WILFUL_DEFAULT,
  SUIT_FILED, GST_STAGE)
SELECT 'CI-RUN-1', 'A' || LPAD(n, 5, '0'), 'C' || LPAD(n, 5, '0'),
       2 + MOD(n, 8), 40000000 + n * 1000000, MOD(n, 3), 2 + MOD(n, 9) * 1.5,
       1500000 + n * 50000, 0.1 + MOD(n, 6) * 0.05, 0.01 + MOD(n, 5) * 0.01, 1 + MOD(n, 7),
       650 + MOD(n * 7, 150), 700 + MOD(n * 3, 80), MOD(n, 4) * 25000, 500000 + n * 20000,
       1.3 + MOD(n, 10) * 0.1, 38000000 + n * 900000, MOD(n, 10) = 0, FALSE,
       CASE WHEN MOD(n, 2) = 0 THEN 'REGULAR' ELSE 'COMPOSITION' END
FROM (SELECT LEVEL n FROM DUAL CONNECT BY LEVEL <= 50);

-- The grade thresholds are those of the PD_SCORE UDF (exasol/udf/05_ml_udfs.sql).
INSERT INTO CREDORA.SCORES (RUN_ID, APP_ID, MODEL_VERSION, PD, GRADE, CONTRIBUTIONS)
SELECT 'CI-RUN-1', 'A' || LPAD(n, 5, '0'), 'v1', pd,
       CASE WHEN pd < 0.01 THEN 'A1' WHEN pd < 0.02 THEN 'A2' WHEN pd < 0.035 THEN 'B1' WHEN pd < 0.05 THEN 'B2'
            WHEN pd < 0.08 THEN 'C1' WHEN pd < 0.12 THEN 'C2' ELSE 'D' END,
       '{"gst_turnover_12m": 0.4, "dscr": -0.2}'
FROM (SELECT LEVEL n, 0.004 + LEVEL * 0.0014 pd FROM DUAL CONNECT BY LEVEL <= 50);

INSERT INTO CREDORA.ANOMALY (RUN_ID, APP_ID, SCORE, IS_ANOMALY, TOP_REASONS)
SELECT 'CI-RUN-1', 'A' || LPAD(n, 5, '0'), CASE WHEN n = 7 THEN 0.91 ELSE 0.2 + MOD(n, 9) * 0.05 END, n = 7,
       CASE WHEN n = 7 THEN 'GST turnover far above bank credits' END
FROM (SELECT LEVEL n FROM DUAL CONNECT BY LEVEL <= 50);

INSERT INTO CREDORA.MODEL_REGISTRY (MODEL_VERSION, TRAINED_AT, ALGORITHM, AUC, GINI, N_TRAIN, DEFAULT_RATE,
  FEATURE_IMPORTANCE, MODEL_PATH, IS_ACTIVE, MODEL_SHA256)
VALUES ('v1', SYSTIMESTAMP, 'Gradient boosted trees, monotonic', 0.81, 0.62, 750, 0.09, '{}',
        '/buckets/bfsdefault/default/models/pd_v1.pkl', TRUE, REPEAT('0', 64));

-- All 13 steps logged as finished, so the run counts as complete for V_LATEST_RUN and PURGE_EXPIRED.
INSERT INTO CREDORA.RUN_LOG (RUN_ID, STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS, DETAIL)
SELECT 'CI-RUN-1', s,
       CASE s WHEN 1 THEN 'Refresh virtual schemas' WHEN 2 THEN 'Read credit needs on file'
              WHEN 3 THEN 'Fetch CIBIL consumer reports (API)' WHEN 4 THEN 'Fetch CIBIL commercial reports (API)'
              WHEN 5 THEN 'Fetch GST returns (API)' WHEN 6 THEN 'Fetch partner accounts at other banks (Account Aggregator API)'
              WHEN 7 THEN 'Compute features' WHEN 8 THEN 'Risk model' WHEN 9 THEN 'Score probability of default (ML UDF)'
              WHEN 10 THEN 'Flag anomalies (Isolation Forest UDF)' WHEN 11 THEN 'Decide offer and negotiation limit'
              WHEN 12 THEN 'Rank with PREFERRING skyline' ELSE 'Shadow-score with the challenger model' END,
       'OK', 50, 100 * s, NULL
FROM (SELECT LEVEL s FROM DUAL CONNECT BY LEVEL <= 13);

INSERT INTO CREDORA.RUN_PUBLISH (RUN_ID, PUBLISHED_BY, PUBLISHED_AT, NOTE)
VALUES ('CI-RUN-1', 'datasci', SYSTIMESTAMP, 'Fixture run of the docker-db check');

-- Loan operations assigned five companies to the second relationship manager.
INSERT INTO CREDORA.RM_ASSIGNMENT (CIF_ID, RM_ID, EXA_USER, ASSIGNED_BY, ASSIGNED_AT)
SELECT 'C' || LPAD(n, 5, '0'), 'RM002', 'CREDORA_RM002', 'loanops', SYSTIMESTAMP
FROM (SELECT LEVEL n FROM DUAL CONNECT BY LEVEL <= 6) WHERE n <> 5;

INSERT INTO CREDORA.LOAN_STATUS_LOG (CIF_ID, RM_ID, STATUS, NOTE, LOGGED_BY, LOGGED_AT)
SELECT 'C' || LPAD(n, 5, '0'), 'RM002', 'ASSIGNED', NULL, 'loanops', SYSTIMESTAMP
FROM (SELECT LEVEL n FROM DUAL CONNECT BY LEVEL <= 6) WHERE n <> 5;

-- Raw 3rd party replies with a purge time. In CI-RUN-1 the rows of even-numbered companies have
-- expired and the rows of odd-numbered companies are still within consent. CI-RUN-0 has expired.
INSERT INTO CREDORA_STAGE.CIBIL_CONSUMER (RUN_ID, PAN, NAME, SCORE, ENQUIRIES_6M, ENQUIRIES_12M, ACCOUNTS,
  ACTIVE_ACCOUNTS, TOTAL_SANCTIONED, TOTAL_BALANCE, TOTAL_OVERDUE, MAX_DPD_12M, MAX_DPD_36M, WRITTEN_OFF,
  FETCHED_AT, PURGE_AT, RAW_JSON)
SELECT r, 'BBBPF' || LPAD(n, 4, '0') || 'P', 'Partner ' || n, 650 + MOD(n * 7, 150), MOD(n, 4), MOD(n, 7),
       2 + MOD(n, 5), 1 + MOD(n, 3), 1000000 + n * 10000, 400000 + n * 5000, MOD(n, 4) * 25000, MOD(n, 30), MOD(n, 60), 0,
       SYSTIMESTAMP, CASE WHEN r = 'CI-RUN-0' OR MOD(n, 2) = 0 THEN ADD_DAYS(SYSTIMESTAMP, -1) ELSE ADD_DAYS(SYSTIMESTAMP, 30) END,
       '{"fixture": true}'
FROM (SELECT LEVEL n FROM DUAL CONNECT BY LEVEL <= 100), (SELECT 'CI-RUN-0' r FROM DUAL UNION ALL SELECT 'CI-RUN-1' FROM DUAL);

INSERT INTO CREDORA_STAGE.CIBIL_COMMERCIAL (RUN_ID, PAN, NAME, CMR_RANK, TOTAL_EXPOSURE, OVERDUE, SUIT_FILED,
  WILFUL_DEFAULT, FACILITIES, FETCHED_AT, PURGE_AT, RAW_JSON)
SELECT r, 'AAACF' || LPAD(n, 4, '0') || 'A', 'Fixture Company ' || n || ' Pvt Ltd', 1 + MOD(n, 7),
       5000000 + n * 100000, MOD(n, 5) * 10000, FALSE, MOD(n, 10) = 0, 1 + MOD(n, 4),
       SYSTIMESTAMP, CASE WHEN r = 'CI-RUN-0' OR MOD(n, 2) = 0 THEN ADD_DAYS(SYSTIMESTAMP, -1) ELSE ADD_DAYS(SYSTIMESTAMP, 30) END,
       '{"fixture": true}'
FROM (SELECT LEVEL n FROM DUAL CONNECT BY LEVEL <= 50), (SELECT 'CI-RUN-0' r FROM DUAL UNION ALL SELECT 'CI-RUN-1' FROM DUAL);

-- 24 monthly returns per company: 1,200 rows per run, so one run spans two fingerprint chunks.
INSERT INTO CREDORA_STAGE.GST_FILING (RUN_ID, GSTIN, LEGAL_NAME, PAN, STATE_NAME, REGISTERED_ON, REG_STATUS, STAGE,
  GST_PERIOD, GSTR1_TURNOVER, GSTR3B_TAX_PAID, DUE_DATE, FILED_ON, DELAY_DAYS, FETCHED_AT, PURGE_AT)
SELECT r, '27AAACF' || LPAD(n, 4, '0') || 'A1Z5', 'Fixture Company ' || n || ' Pvt Ltd', 'AAACF' || LPAD(n, 4, '0') || 'A',
       'Maharashtra', DATE '2019-07-01', 'ACTIVE', 'REGULAR',
       TO_CHAR(ADD_MONTHS(DATE '2024-10-01', m - 1), 'YYYY-MM'),
       3000000 + n * 80000 + m * 1000, 540000 + n * 14400 + m * 180,
       ADD_MONTHS(DATE '2024-11-11', m - 1), ADD_DAYS(ADD_MONTHS(DATE '2024-11-11', m - 1), MOD(n + m, 3)), MOD(n + m, 3),
       SYSTIMESTAMP, CASE WHEN r = 'CI-RUN-0' OR MOD(n, 2) = 0 THEN ADD_DAYS(SYSTIMESTAMP, -1) ELSE ADD_DAYS(SYSTIMESTAMP, 30) END
FROM (SELECT LEVEL n FROM DUAL CONNECT BY LEVEL <= 50), (SELECT LEVEL m FROM DUAL CONNECT BY LEVEL <= 24),
     (SELECT 'CI-RUN-0' r FROM DUAL UNION ALL SELECT 'CI-RUN-1' FROM DUAL);

INSERT INTO CREDORA_STAGE.AA_ACCOUNT (RUN_ID, PAN, CONSENT_ID, CONSENT_EXPIRES, AA_ACCOUNT_ID, FIP, ACCT_TYPE, MASKED_NO,
  OPENED_ON, CURRENT_BALANCE, TXN_COUNT, CREDITS_12M, DEBITS_12M, FETCHED_AT, PURGE_AT)
SELECT r, 'BBBPF' || LPAD(n, 4, '0') || 'P', 'consent-' || LPAD(n, 4, '0'), ADD_DAYS(SYSTIMESTAMP, 30),
       'AA' || LPAD(n, 6, '0'), CASE MOD(n, 3) WHEN 0 THEN 'Other Bank A' WHEN 1 THEN 'Other Bank B' ELSE 'Other Bank C' END,
       'SAVINGS', 'XXXXXX' || LPAD(n, 4, '0'), DATE '2020-01-15', 200000 + n * 3000, 120 + n, 2400000 + n * 30000,
       2350000 + n * 29000, SYSTIMESTAMP,
       CASE WHEN r = 'CI-RUN-0' OR MOD(n, 2) = 0 THEN ADD_DAYS(SYSTIMESTAMP, -1) ELSE ADD_DAYS(SYSTIMESTAMP, 30) END
FROM (SELECT LEVEL n FROM DUAL CONNECT BY LEVEL <= 100), (SELECT 'CI-RUN-0' r FROM DUAL UNION ALL SELECT 'CI-RUN-1' FROM DUAL);

COMMIT;
