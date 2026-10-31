-- Row-level security for relationship managers, and the publish step, enforced by Exasol itself.
--
-- Loan operations assigns companies to relationship managers (CREDORA.RM_ASSIGNMENT); the manager
-- logs the loan status of each (CREDORA.LOAN_STATUS_LOG). The data scientist publishes an analysis
-- run to loan operations (CREDORA.RUN_PUBLISH); only published runs are official. The web app
-- writes all three tables as CREDORA_SVC; no role user can write them.
--
-- A relationship manager reads only the V_RM_* views below. Each view joins RM_ASSIGNMENT on
-- EXA_USER = CURRENT_USER and RUN_PUBLISH, so Exasol returns only the companies assigned to the
-- Exasol user that is logged in, from published runs, at full detail (unmasked PAN and GSTIN,
-- features and scores). Views run with their owner's rights, so R_RM needs no grant on the tables
-- underneath; it has none on DECISIONS, SCORES, FEATURES, APPLICATIONS or V_COMPANY_MASKED, and
-- reading them fails with "insufficient privileges".
--
-- The demo has one relationship manager login: Exasol user CREDORA_RM acts for RM001. In production
-- each relationship manager gets an own Exasol user with role R_RM, loan operations assigns to that
-- user, and these views work unchanged: CURRENT_USER picks the rows.
--
-- Runs after 07_security.sql (V_COMPANY_MASKED) and before exasol/semantic/11_latest_run_views.sql,
-- whose V_LATEST_* views use RUN_PUBLISH and the same row filter (V_SESSION_SCOPE).

-- Who works which company. One row per company: assigning again moves it to another manager.
CREATE TABLE IF NOT EXISTS CREDORA.RM_ASSIGNMENT (
  CIF_ID      VARCHAR(8) NOT NULL,
  RM_ID       VARCHAR(6) NOT NULL,     -- relationship manager in the customer master (cif.rm)
  EXA_USER    VARCHAR(128) NOT NULL,   -- the Exasol user that logs in for this manager
  ASSIGNED_BY VARCHAR(20) NOT NULL,    -- web app user of loan operations
  ASSIGNED_AT TIMESTAMP NOT NULL
);

-- Published analysis runs. A finished run is a draft until the data scientist publishes it; the
-- latest published run is the official one that loan operations and relationship managers see.
CREATE TABLE IF NOT EXISTS CREDORA.RUN_PUBLISH (
  RUN_ID       VARCHAR(20) NOT NULL,
  PUBLISHED_BY VARCHAR(40) NOT NULL,
  PUBLISHED_AT TIMESTAMP NOT NULL,
  NOTE         VARCHAR(400)
);

-- Loan status per assigned company, logged by the relationship manager as she talks to the customer
-- (and an ASSIGNED row when loan operations assigns or moves the company). Full history: the newest
-- row per company is its current status. STATUS is ASSIGNED, CONTACTED, NEGOTIATING, LOAN_TAKEN,
-- IN_PROGRESS, DISBURSED or NOT_INTERESTED.
CREATE TABLE IF NOT EXISTS CREDORA.LOAN_STATUS_LOG (
  EVENT_ID   DECIMAL(18) IDENTITY,
  CIF_ID     VARCHAR(8) NOT NULL,
  RM_ID      VARCHAR(6) NOT NULL,
  STATUS     VARCHAR(16) NOT NULL,
  NOTE       VARCHAR(400),
  LOGGED_BY  VARCHAR(20) NOT NULL,
  LOGGED_AT  TIMESTAMP NOT NULL
);

-- Existing deployments: the newest finished run becomes the first published run, so the site keeps
-- showing results. Does nothing once any run is published.
INSERT INTO CREDORA.RUN_PUBLISH (RUN_ID, PUBLISHED_BY, PUBLISHED_AT, NOTE)
SELECT RUN_ID, 'system', SYSTIMESTAMP, 'Published when the publish step was introduced'
FROM (
  SELECT RUN_ID, MAX(LOGGED_AT) FINISHED_AT
  FROM CREDORA.RUN_LOG
  GROUP BY RUN_ID
  HAVING SUM(CASE WHEN STATUS = 'FAILED' THEN 1 ELSE 0 END) = 0
     AND (MAX(STEP_NO) >= 13
          OR MAX(CASE WHEN STEP_NO = 11 AND STEP_NAME = 'Rank with PREFERRING skyline' THEN 1 ELSE 0 END) = 1)
  ORDER BY FINISHED_AT DESC LIMIT 1
)
WHERE NOT EXISTS (SELECT 1 FROM CREDORA.RUN_PUBLISH);

-- One row: is the logged-in Exasol user a relationship manager (role R_RM)? Read with the view
-- owner's rights, so the dictionary lookup works for every caller. Not granted to anyone; the
-- V_LATEST_* views use it to filter rows.
CREATE OR REPLACE VIEW CREDORA.V_SESSION_SCOPE AS
SELECT CURRENT_USER EXA_USER,
       CASE WHEN EXISTS (SELECT 1 FROM EXA_DBA_ROLE_PRIVS p
                         WHERE p.GRANTEE = CURRENT_USER AND p.GRANTED_ROLE = 'R_RM') THEN TRUE ELSE FALSE END IS_RM
FROM DUAL;

-- The relationship manager's own book: assignments of the logged-in Exasol user.
CREATE OR REPLACE VIEW CREDORA.V_RM_ASSIGNMENT AS
SELECT a.CIF_ID, a.RM_ID, a.ASSIGNED_BY, a.ASSIGNED_AT
FROM CREDORA.RM_ASSIGNMENT a
WHERE a.EXA_USER = CURRENT_USER;

-- Decisions of assigned companies in published runs (same columns as CREDORA.DECISIONS).
CREATE OR REPLACE VIEW CREDORA.V_RM_DECISIONS AS
SELECT d.*
FROM CREDORA.DECISIONS d
JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = d.CIF_ID AND a.EXA_USER = CURRENT_USER
JOIN CREDORA.RUN_PUBLISH p ON p.RUN_ID = d.RUN_ID;

-- Company details of assigned companies, unmasked: full PAN and GSTIN.
CREATE OR REPLACE VIEW CREDORA.V_RM_COMPANY AS
SELECT c.RUN_ID, c.APP_ID, c.CIF_ID, c.LEGAL_NAME, c.CONSTITUTION, c.PAN, c.GSTIN, c.INDUSTRY, c.CITY,
       c.STATE_NAME, c.RM_ID, c.KYC_STATUS, c.PRODUCT, c.AMOUNT_REQUESTED, c.TENURE_REQUESTED, c.PURPOSE,
       c.COLLATERAL_TYPE, c.COLLATERAL_VALUE, c.PARTNERS, f.GST_STAGE, f.GST_YEARS,
       a.RM_ID ASSIGNED_RM_ID, a.ASSIGNED_BY, a.ASSIGNED_AT
FROM CREDORA.APPLICATIONS c
JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = c.CIF_ID AND a.EXA_USER = CURRENT_USER
JOIN CREDORA.RUN_PUBLISH p ON p.RUN_ID = c.RUN_ID
LEFT JOIN CREDORA.FEATURES f ON f.RUN_ID = c.RUN_ID AND f.APP_ID = c.APP_ID;

-- Risk model inputs of assigned companies (same columns as CREDORA.FEATURES).
CREATE OR REPLACE VIEW CREDORA.V_RM_FEATURES AS
SELECT f.*
FROM CREDORA.FEATURES f
JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = f.CIF_ID AND a.EXA_USER = CURRENT_USER
JOIN CREDORA.RUN_PUBLISH p ON p.RUN_ID = f.RUN_ID;

-- Risk scores of assigned companies (same columns as CREDORA.SCORES).
CREATE OR REPLACE VIEW CREDORA.V_RM_SCORES AS
SELECT s.*
FROM CREDORA.SCORES s
JOIN CREDORA.DECISIONS d ON d.RUN_ID = s.RUN_ID AND d.APP_ID = s.APP_ID
JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = d.CIF_ID AND a.EXA_USER = CURRENT_USER
JOIN CREDORA.RUN_PUBLISH p ON p.RUN_ID = s.RUN_ID;

-- Loan status history of the assigned companies.
CREATE OR REPLACE VIEW CREDORA.V_RM_LOAN_STATUS AS
SELECT l.EVENT_ID, l.CIF_ID, l.RM_ID, l.STATUS, l.NOTE, l.LOGGED_BY, l.LOGGED_AT
FROM CREDORA.LOAN_STATUS_LOG l
JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = l.CIF_ID AND a.EXA_USER = CURRENT_USER;

-- Relationship managers: the views above, the policy and the run log; nothing else in CREDORA.
GRANT SELECT ON CREDORA.V_RM_LOAN_STATUS TO R_RM;
GRANT SELECT ON CREDORA.V_RM_ASSIGNMENT TO R_RM;
GRANT SELECT ON CREDORA.V_RM_DECISIONS TO R_RM;
GRANT SELECT ON CREDORA.V_RM_COMPANY TO R_RM;
GRANT SELECT ON CREDORA.V_RM_FEATURES TO R_RM;
GRANT SELECT ON CREDORA.V_RM_SCORES TO R_RM;
GRANT SELECT ON CREDORA.RUN_PUBLISH TO R_RM;

-- Deployments made before this file granted R_RM the tables directly (07_security.sql no longer
-- does). Take those grants back; REVOKE fails when nothing was granted, so pquery tries each one.
--/
CREATE OR REPLACE SCRIPT CREDORA.RM_REVOKE_DIRECT_GRANTS() AS
for _, t in ipairs({'DECISIONS', 'SCORES', 'FEATURES', 'APPLICATIONS', 'V_COMPANY_MASKED'}) do
  pquery('REVOKE SELECT ON CREDORA.' .. t .. ' FROM R_RM')
end
/
EXECUTE SCRIPT CREDORA.RM_REVOKE_DIRECT_GRANTS();
DROP SCRIPT CREDORA.RM_REVOKE_DIRECT_GRANTS;
