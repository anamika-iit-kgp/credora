-- CREDORA.PURGE_EXPIRED() deletes raw 3rd party data (CIBIL, GST, Account Aggregator replies) whose
-- purge time has passed. Before deleting, it records how many rows go and a SHA-256 fingerprint of
-- their content in CREDORA.PURGE_LOG, so an auditor can confirm what was deleted without the data.
-- The Exasol Scheduler (exasol-labs/exasol-scheduler, task credora_purge_expired in SCHED.SCHED_TASKS,
-- exasol/sql/17_scheduler.sql) runs it every 15 minutes as CREDORA_SVC, inside Exasol; each run is a
-- row in SCHED.SCHED_HISTORY. The web app runs it too only if its fallback switch PURGE_INTERVAL_MIN
-- is set (off by default).

CREATE OR REPLACE LUA SCRIPT CREDORA.PURGE_EXPIRED() RETURNS TABLE AS
local targets = {
  {t = 'CIBIL_CONSUMER',   key = 'PAN || SCORE || TOTAL_OVERDUE'},
  {t = 'CIBIL_COMMERCIAL', key = 'PAN || CMR_RANK || OVERDUE'},
  {t = 'GST_FILING',       key = 'GSTIN || GST_PERIOD || GSTR1_TURNOVER'},
  {t = 'AA_ACCOUNT',       key = 'PAN || AA_ACCOUNT_ID || CURRENT_BALANCE'},
}
local out = {}
for _, x in ipairs(targets) do
  local runs = query([[SELECT RUN_ID, COUNT(*) N,
                              HASH_SHA256(LISTAGG(]] .. x.key .. [[, '|') WITHIN GROUP (ORDER BY ]] .. x.key .. [[)) H
                       FROM CREDORA_STAGE.]] .. x.t .. [[ WHERE PURGE_AT <= SYSTIMESTAMP GROUP BY RUN_ID]])
  for i = 1, #runs do
    query([[INSERT INTO CREDORA.PURGE_LOG VALUES (SYSTIMESTAMP, :t, :r, :n, :h)]],
          {t = 'CREDORA_STAGE.' .. x.t, r = runs[i].RUN_ID, n = runs[i].N, h = runs[i].H})
    query('DELETE FROM CREDORA_STAGE.' .. x.t .. ' WHERE RUN_ID = :r AND PURGE_AT <= SYSTIMESTAMP', {r = runs[i].RUN_ID})
    out[#out + 1] = {x.t, runs[i].RUN_ID, runs[i].N}
  end
end
exit(out, "table_name VARCHAR(60), run_id VARCHAR(20), rows_deleted DECIMAL(18)")
/
