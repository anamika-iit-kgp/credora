-- Workload management: the AI cannot starve or hang the bank's analysis.
--
-- Three consumer groups, one per kind of work. Exasol shares CPU by CPU_WEIGHT, runs higher
-- PRECEDENCE first when the node is busy, and cancels a statement that runs past QUERY_TIMEOUT:
--
--   CREDORA_BATCH  high   CREDORA_SVC: RUN_ANALYSIS, TRAIN_MODEL, the CRM export and the jobs the
--                         Exasol Scheduler runs (PURGE_EXPIRED, the nightly virtual-schema refresh)
--   CREDORA_APP    medium the role users behind the web app's screens (CREDORA_ADMIN, _DATASCI,
--                         _LOANOPS, _RM and the second relationship manager CREDORA_RM002). A
--                         screen query is cancelled after 5 minutes
--   CREDORA_AI     low    Ask Credora's sessions, 60 s per statement, at most 2 GiB of temporary
--                         memory per session and 4 GiB for the group
--
-- Exasol assigns a consumer group per user or role, and a session cannot switch groups, so Ask
-- Credora never logs in as the person. Each person has an AI session user, CREDORA_ADMIN_AI,
-- CREDORA_DATASCI_AI, CREDORA_LOANOPS_AI or CREDORA_RM_AI, which holds the same role as the person
-- and sits in CREDORA_AI, so the group's limits apply to every statement the AI runs, with no
-- session settings to get right. CREDORA_MCP, also in CREDORA_AI, is the read-only user for MCP clients
-- outside the app. The row filter of the V_RM_* views treats an AI session user as its person
-- (13_rm_row_security.sql), so CREDORA_RM_AI sees exactly CREDORA_RM's book.
--
-- SELECT ANY DICTIONARY goes to the user CREDORA_ADMIN, not to the role R_ADMIN. The admin's
-- screens read the audit log and the system tables with it, and the admin's AI session user does
-- not, so the AI cannot read the audit log or the system tables of anyone.
--
-- The groups are created by the deploy tool (deploy/exasol_setup.py ensure_consumer_groups), which
-- has to check whether they exist first; this file sets their limits and assigns the users, so it
-- runs after the users exist. Re-running it is safe.

ALTER CONSUMER GROUP CREDORA_BATCH SET PRECEDENCE = '900', CPU_WEIGHT = '900', QUERY_TIMEOUT = 0;
ALTER CONSUMER GROUP CREDORA_APP SET PRECEDENCE = '500', CPU_WEIGHT = '400', QUERY_TIMEOUT = 300;
ALTER CONSUMER GROUP CREDORA_AI SET PRECEDENCE = '100', CPU_WEIGHT = '100', QUERY_TIMEOUT = 60,
  SESSION_TEMP_DB_RAM_LIMIT = '2G', GROUP_TEMP_DB_RAM_LIMIT = '4G';

COMMENT ON CONSUMER GROUP CREDORA_BATCH IS 'Credora batch work, high priority: analysis, training, CRM export and the Exasol Scheduler jobs (CREDORA_SVC).';
COMMENT ON CONSUMER GROUP CREDORA_APP IS 'Credora web app screens, medium priority, 5-minute statement limit (the role users, including the second relationship manager).';
COMMENT ON CONSUMER GROUP CREDORA_AI IS 'Ask Credora, low priority: 60-second statement limit, 2 GiB temporary memory per session (the AI session users CREDORA_*_AI and the read-only CREDORA_MCP).';

ALTER USER CREDORA_SVC SET CONSUMER_GROUP = CREDORA_BATCH;
ALTER USER CREDORA_ADMIN SET CONSUMER_GROUP = CREDORA_APP;
ALTER USER CREDORA_DATASCI SET CONSUMER_GROUP = CREDORA_APP;
ALTER USER CREDORA_LOANOPS SET CONSUMER_GROUP = CREDORA_APP;
ALTER USER CREDORA_RM SET CONSUMER_GROUP = CREDORA_APP;
ALTER USER CREDORA_RM002 SET CONSUMER_GROUP = CREDORA_APP;
ALTER USER CREDORA_ADMIN_AI SET CONSUMER_GROUP = CREDORA_AI;
ALTER USER CREDORA_DATASCI_AI SET CONSUMER_GROUP = CREDORA_AI;
ALTER USER CREDORA_LOANOPS_AI SET CONSUMER_GROUP = CREDORA_AI;
ALTER USER CREDORA_RM_AI SET CONSUMER_GROUP = CREDORA_AI;
ALTER USER CREDORA_MCP SET CONSUMER_GROUP = CREDORA_AI;

-- The admin's own user reads the system tables and the audit log. The role R_ADMIN does not carry
-- this (07_security.sql), so CREDORA_ADMIN_AI, which holds the role only, cannot.
GRANT SELECT ANY DICTIONARY TO CREDORA_ADMIN;

-- Password rules for every password set from now on. The deployment's generated Exasol passwords
-- (24 random letters and digits, infra/main.tf) and the launcher's own pass these; the web app's
-- demo logins are not Exasol users and are unaffected. No lock-out rule: a locked role user would
-- take its screens down, and Exasol's ports are open to the admins' IPs only.
ALTER SYSTEM SET PASSWORD_SECURITY_POLICY = 'MIN_LENGTH=12:MIN_LOWER_CASE=1:MIN_UPPER_CASE=1';
