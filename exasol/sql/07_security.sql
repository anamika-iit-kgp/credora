-- Who may see what, enforced by Exasol itself. The web app logs in to Exasol as the database
-- user that matches the signed-in person's role, so a bug in the app cannot widen access.
--
--   CREDORA_SVC      runs the analysis, training and purge (service account of the web app)
--   CREDORA_ADMIN    everything, read-only
--   CREDORA_DATASCI  everything, read-only; trains models
--   CREDORA_LOANOPS  bank data and Exasol results, NOT the raw 3rd party data (CIBIL, GST, AA)
--   CREDORA_RM       only the companies assigned to it, through row-filtered views (13_rm_row_security.sql)
--   CREDORA_MCP      read-only results for the AI assistant (MCP)
--
-- The roles themselves are created by the deploy tool (deploy/exasol_setup.py), which has to
-- check whether they exist first.


-- Masked customer view for relationship managers: PAN and GSTIN show only their last characters.
CREATE OR REPLACE VIEW CREDORA.V_COMPANY_MASKED AS
SELECT a.RUN_ID, a.APP_ID, a.CIF_ID, a.LEGAL_NAME, a.CONSTITUTION,
       'XXXXXX' || SUBSTR(a.PAN, 7, 4) PAN_MASKED, SUBSTR(a.GSTIN, 1, 2) || 'XXXXXXXXX' || SUBSTR(a.GSTIN, 12, 4) GSTIN_MASKED,
       a.INDUSTRY, a.CITY, a.STATE_NAME, a.RM_ID, a.PRODUCT, a.AMOUNT_REQUESTED, a.TENURE_REQUESTED, a.PURPOSE, a.PARTNERS,
       f.GST_STAGE, f.GST_YEARS
FROM CREDORA.APPLICATIONS a
LEFT JOIN CREDORA.FEATURES f ON f.RUN_ID = a.RUN_ID AND f.APP_ID = a.APP_ID;

GRANT CREATE SESSION TO R_SVC, R_ADMIN, R_DATASCI, R_LOANOPS, R_RM, R_MCP;

-- Service account: owns the analysis.
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA CREDORA TO R_SVC;
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA CREDORA_STAGE TO R_SVC;
GRANT CREATE TABLE, DROP ANY TABLE TO R_SVC;
GRANT EXECUTE ON SCHEMA CREDORA TO R_SVC;
GRANT SELECT ON SCHEMA VS_CBS TO R_SVC;
GRANT SELECT ON SCHEMA VS_CIF TO R_SVC;
GRANT SELECT ON SCHEMA VS_LOS TO R_SVC;
GRANT ALTER ANY VIRTUAL SCHEMA REFRESH TO R_SVC;
GRANT ACCESS ON CONNECTION MOCK_CIBIL TO R_SVC;
GRANT ACCESS ON CONNECTION MOCK_GSTN TO R_SVC;
GRANT ACCESS ON CONNECTION MOCK_AA TO R_SVC;
GRANT ACCESS ON CONNECTION BUCKETFS_MODELS TO R_SVC;

-- Admin and data scientist: everything, read-only.
GRANT SELECT ON SCHEMA CREDORA TO R_ADMIN, R_DATASCI;
GRANT SELECT ON SCHEMA CREDORA_STAGE TO R_ADMIN, R_DATASCI;
GRANT SELECT ON SCHEMA VS_CBS TO R_ADMIN, R_DATASCI, R_LOANOPS;
GRANT SELECT ON SCHEMA VS_CIF TO R_ADMIN, R_DATASCI, R_LOANOPS;
GRANT SELECT ON SCHEMA VS_LOS TO R_ADMIN, R_DATASCI, R_LOANOPS;
GRANT SELECT ANY DICTIONARY TO R_ADMIN;

-- Loan operations: Exasol results, no raw API replies.
GRANT SELECT ON SCHEMA CREDORA TO R_LOANOPS;

-- Relationship managers: the policy and the run log here; their companies only through the
-- row-filtered V_RM_* views of 13_rm_row_security.sql (no grant on DECISIONS, SCORES, FEATURES,
-- APPLICATIONS or V_COMPANY_MASKED).
GRANT SELECT ON CREDORA.CONFIG TO R_RM;
GRANT SELECT ON CREDORA.RUN_LOG TO R_RM;
-- Not CREDORA.ANOMALY or CREDORA.CHALLENGER_SCORES: an RM sees an anomaly only as the reason text in
-- DECISIONS.HARD_FAILS ("Anomaly: ..."), never the scores. (R_SVC writes both through its schema
-- grants; R_ADMIN, R_DATASCI and R_LOANOPS read both through SELECT ON SCHEMA CREDORA.)

-- AI assistant (MCP): read-only, results only.
GRANT SELECT ON CREDORA.DECISIONS TO R_MCP;
GRANT SELECT ON CREDORA.SCORES TO R_MCP;
GRANT SELECT ON CREDORA.FEATURES TO R_MCP;
GRANT SELECT ON CREDORA.RUN_LOG TO R_MCP;
GRANT SELECT ON CREDORA.MODEL_REGISTRY TO R_MCP;
GRANT SELECT ON CREDORA.CHALLENGER_SCORES TO R_MCP;
GRANT SELECT ON CREDORA.ANOMALY TO R_MCP;
GRANT SELECT ON CREDORA.CONFIG TO R_MCP;
GRANT SELECT ON CREDORA.V_COMPANY_MASKED TO R_MCP;
