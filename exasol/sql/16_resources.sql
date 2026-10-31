-- Workload management: the AI cannot starve or hang the bank's analysis.
--
-- Three consumer groups, one per kind of work. Exasol shares CPU by CPU_WEIGHT, runs higher
-- PRECEDENCE first when the node is busy, and cancels a statement that runs past QUERY_TIMEOUT:
--
--   CREDORA_BATCH  high   CREDORA_SVC: RUN_ANALYSIS, TRAIN_MODEL, the CRM export and the jobs the
--                         Exasol Scheduler runs (PURGE_EXPIRED, the nightly virtual-schema refresh)
--   CREDORA_APP    medium the role users behind the web app's screens (CREDORA_ADMIN, _DATASCI,
--                         _LOANOPS, _RM); a screen query is cancelled after 5 minutes
--   CREDORA_AI     low    CREDORA_MCP, the read-only fallback user of Ask Credora: 60 s per
--                         statement, at most 2 GiB of temporary memory per session
--
-- Exasol assigns a consumer group per user or role; a session cannot switch groups (ALTER SESSION
-- has no CONSUMER_GROUP). Ask Credora logs in as the signed-in person's own role user, so its MCP
-- sessions are in CREDORA_APP like that person's screens, and the AI's limits are set per session
-- instead: the backend starts the Exasol MCP server through backend/app/mcp_session.py, which runs
--   ALTER SESSION SET QUERY_TIMEOUT = 60; ALTER SESSION SET NICE = 'ON';
--   ALTER SESSION SET SESSION_TEMP_DB_RAM_LIMIT = '2G'
-- as soon as each MCP connection opens (NICE lowers the session's weight inside its group).
--
-- The groups are created by the deploy tool (deploy/exasol_setup.py ensure_consumer_groups), which
-- has to check whether they exist first; this file sets their limits and assigns the users, so it
-- runs after the users exist. Re-running it is safe.

ALTER CONSUMER GROUP CREDORA_BATCH SET PRECEDENCE = '900', CPU_WEIGHT = '900', QUERY_TIMEOUT = 0;
ALTER CONSUMER GROUP CREDORA_APP SET PRECEDENCE = '500', CPU_WEIGHT = '400', QUERY_TIMEOUT = 300;
ALTER CONSUMER GROUP CREDORA_AI SET PRECEDENCE = '100', CPU_WEIGHT = '100', QUERY_TIMEOUT = 60,
  SESSION_TEMP_DB_RAM_LIMIT = '2G', GROUP_TEMP_DB_RAM_LIMIT = '4G';

COMMENT ON CONSUMER GROUP CREDORA_BATCH IS 'Credora batch work, high priority: analysis, training, CRM export and the Exasol Scheduler jobs (CREDORA_SVC).';
COMMENT ON CONSUMER GROUP CREDORA_APP IS 'Credora web app screens, medium priority, 5-minute statement limit (the four role users).';
COMMENT ON CONSUMER GROUP CREDORA_AI IS 'Ask Credora, low priority: 60-second statement limit, 2 GiB temporary memory per session (CREDORA_MCP; role-user AI sessions get the same limits per session).';

ALTER USER CREDORA_SVC SET CONSUMER_GROUP = CREDORA_BATCH;
ALTER USER CREDORA_ADMIN SET CONSUMER_GROUP = CREDORA_APP;
ALTER USER CREDORA_DATASCI SET CONSUMER_GROUP = CREDORA_APP;
ALTER USER CREDORA_LOANOPS SET CONSUMER_GROUP = CREDORA_APP;
ALTER USER CREDORA_RM SET CONSUMER_GROUP = CREDORA_APP;
ALTER USER CREDORA_MCP SET CONSUMER_GROUP = CREDORA_AI;

-- Password rules for every password set from now on. The deployment's generated Exasol passwords
-- (24 random letters and digits, infra/main.tf) and the launcher's own pass these; the web app's
-- demo logins are not Exasol users and are unaffected. No lock-out rule: a locked role user would
-- take its screens down, and Exasol's ports are open to the admins' IPs only.
ALTER SYSTEM SET PASSWORD_SECURITY_POLICY = 'MIN_LENGTH=12:MIN_LOWER_CASE=1:MIN_UPPER_CASE=1';
