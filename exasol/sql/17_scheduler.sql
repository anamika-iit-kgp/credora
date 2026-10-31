-- Scheduled work inside the Exasol ecosystem: exasol-labs/exasol-scheduler (pinned in
-- scheduler/Dockerfile) runs the SQL in SCHED.SCHED_TASKS on cron schedules and writes every run to
-- SCHED.SCHED_HISTORY, in this database. It runs as one container on the app host (docker-compose.yml,
-- service "scheduler") and logs in as CREDORA_SVC, so its sessions are in consumer group CREDORA_BATCH.
--
--   credora_purge_expired            every 15 min  EXECUTE SCRIPT CREDORA.PURGE_EXPIRED(): consent-based
--                                                  3rd party data deleted on time, proof in PURGE_LOG
--   credora_refresh_vs_cbs           02:00 IST     ALTER VIRTUAL SCHEMA VS_CBS REFRESH (Oracle metadata)
--     credora_refresh_vs_cif         after it      ALTER VIRTUAL SCHEMA VS_CIF REFRESH (MySQL), and
--     credora_refresh_vs_los         after it      ALTER VIRTUAL SCHEMA VS_LOS REFRESH (PostgreSQL);
--                                                  both are finalizers, so they run even if Oracle fails
--
-- The tables are created here, by the deploy user, before the scheduler first starts (the
-- upstream least-privilege setup, docs/security.md): the scheduler only reads SCHED_TASKS and
-- appends to SCHED_HISTORY. SCHED_TASKS is a code-execution surface, so nobody but the deploy user
-- may write it; the admin and the data scientist may read both tables (the Exasol audit screen).
-- DDL as in the scheduler's docs/configuration.md. Re-running this file is safe.

CREATE SCHEMA IF NOT EXISTS SCHED;

CREATE TABLE IF NOT EXISTS SCHED.SCHED_TASKS (
    "TASK_ID"           VARCHAR(128) NOT NULL,
    "ENABLED"           BOOLEAN DEFAULT TRUE,
    "SCHEDULE"          VARCHAR(512),
    "SQL_TEXT"          VARCHAR(2000000) NOT NULL,
    "AFTER"             VARCHAR(128),
    "IS_FINAL"          BOOLEAN DEFAULT FALSE,
    "PARALLEL_CHILDREN" BOOLEAN DEFAULT TRUE,
    "COMMENT"           VARCHAR(2000),
    PRIMARY KEY ("TASK_ID")
);

CREATE TABLE IF NOT EXISTS SCHED.SCHED_HISTORY (
    "RUN_ID"        VARCHAR(36) NOT NULL,
    "GRAPH_RUN_ID"  VARCHAR(36),
    "TASK_ID"       VARCHAR(128) NOT NULL,
    "GRAPH_PHASE"   VARCHAR(16) NOT NULL,
    "SCHEDULED_FOR" TIMESTAMP,
    "STARTED_AT"    TIMESTAMP NOT NULL,
    "FINISHED_AT"   TIMESTAMP,
    "STATUS"        VARCHAR(16) NOT NULL,
    "ERROR_MESSAGE" VARCHAR(2000000),
    PRIMARY KEY ("RUN_ID")
);

-- One statement, so the scheduler (which reloads on change) sees the whole task graph at once.
MERGE INTO SCHED.SCHED_TASKS t USING (
  SELECT 'credora_purge_expired' TASK_ID, 'CRON 0 */15 * * * * TZ=Asia/Kolkata' SCHED, 'EXECUTE SCRIPT CREDORA.PURGE_EXPIRED()' SQL_TEXT,
         CAST(NULL AS VARCHAR(128)) AFTER_ID, FALSE IS_FINAL,
         'Delete consent-based 3rd party data (CIBIL, GST, Account Aggregator) whose PURGE_AT has passed. Row counts and SHA-256 proof go to CREDORA.PURGE_LOG.' CMT FROM DUAL
  UNION ALL SELECT 'credora_refresh_vs_cbs', 'CRON 0 0 2 * * * TZ=Asia/Kolkata', 'ALTER VIRTUAL SCHEMA VS_CBS REFRESH', NULL, FALSE,
         'Nightly: refresh the metadata of the Oracle core-banking virtual schema.' FROM DUAL
  UNION ALL SELECT 'credora_refresh_vs_cif', NULL, 'ALTER VIRTUAL SCHEMA VS_CIF REFRESH', 'credora_refresh_vs_cbs', TRUE,
         'Nightly, after VS_CBS (even if it failed): refresh the MySQL customer-master virtual schema.' FROM DUAL
  UNION ALL SELECT 'credora_refresh_vs_los', NULL, 'ALTER VIRTUAL SCHEMA VS_LOS REFRESH', 'credora_refresh_vs_cbs', TRUE,
         'Nightly, after VS_CBS (even if it failed): refresh the PostgreSQL loan-origination virtual schema.' FROM DUAL
) s ON t."TASK_ID" = s.TASK_ID
WHEN MATCHED THEN UPDATE SET t."SCHEDULE" = s.SCHED, t."SQL_TEXT" = s.SQL_TEXT, t."AFTER" = s.AFTER_ID,
  t."IS_FINAL" = s.IS_FINAL, t."COMMENT" = s.CMT
WHEN NOT MATCHED THEN INSERT ("TASK_ID", "ENABLED", "SCHEDULE", "SQL_TEXT", "AFTER", "IS_FINAL", "PARALLEL_CHILDREN", "COMMENT")
  VALUES (s.TASK_ID, TRUE, s.SCHED, s.SQL_TEXT, s.AFTER_ID, s.IS_FINAL, TRUE, s.CMT);

GRANT SELECT ON SCHED.SCHED_TASKS TO R_SVC;
GRANT INSERT ON SCHED.SCHED_HISTORY TO R_SVC;
GRANT SELECT ON SCHED.SCHED_TASKS TO R_ADMIN, R_DATASCI;
GRANT SELECT ON SCHED.SCHED_HISTORY TO R_ADMIN, R_DATASCI;

COMMENT ON SCHEMA SCHED IS 'exasol-labs/exasol-scheduler, which runs Credora''s scheduled jobs (SCHED_TASKS) and every run of them (SCHED_HISTORY).';
COMMENT ON TABLE SCHED.SCHED_TASKS IS 'Jobs the Exasol Scheduler runs: one row per task, cron schedule, SQL, and the task it runs after. Writable by the deploy user only.' (
  "TASK_ID" IS 'Task name; child tasks name their parent in AFTER',
  "ENABLED" IS 'FALSE pauses the task without deleting it',
  "SCHEDULE" IS 'CRON <sec> <min> <hour> <day> <month> <weekday> TZ=<zone>; NULL for a child task',
  "SQL_TEXT" IS 'The SQL the scheduler runs, verbatim, as CREDORA_SVC',
  "AFTER" IS 'Parent task; this one runs after it',
  "IS_FINAL" IS 'Finalizer: runs after the parent even if the parent failed',
  "PARALLEL_CHILDREN" IS 'Children of this task run in parallel',
  "COMMENT" IS 'What the task is for'
);
COMMENT ON TABLE SCHED.SCHED_HISTORY IS 'Every run of every scheduled task, written by the Exasol Scheduler: SUCCEEDED, FAILED, SKIPPED or INVALID.' (
  "RUN_ID" IS 'Id of this task run',
  "GRAPH_RUN_ID" IS 'Shared by all tasks of one trigger of a task graph',
  "TASK_ID" IS 'The task',
  "GRAPH_PHASE" IS 'MAIN (a scheduled root), CHILD, FINAL (a finalizer) or VALIDATION',
  "SCHEDULED_FOR" IS 'When the trigger was due (UTC)',
  "STARTED_AT" IS 'When the task started (UTC)',
  "FINISHED_AT" IS 'When it finished (UTC)',
  "STATUS" IS 'SUCCEEDED, FAILED, SKIPPED or INVALID',
  "ERROR_MESSAGE" IS 'Exasol''s error for a failed task'
);
