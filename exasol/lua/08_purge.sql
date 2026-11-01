-- CREDORA.PURGE_EXPIRED() deletes raw 3rd party data (CIBIL, GST, Account Aggregator replies) whose
-- purge time has passed. Before deleting, it records how many rows go and a SHA-256 fingerprint of
-- their content in CREDORA.PURGE_LOG, so an auditor can confirm what was deleted without the data.
--
-- The fingerprint is built in chunks. One run holds about 72,000 GST rows, and one LISTAGG over all
-- of their keys would exceed Exasol's VARCHAR limit of 2,000,000 characters. So the rows of a run are
-- sorted by key and cut into chunks of 1,000 rows, each chunk is hashed, and the run's fingerprint is
-- the hash of the chunk hashes in chunk order. An auditor can recompute it from the same rule.
--
-- Each staging table is purged in its own transaction (pcall, then COMMIT). A failure in one table is
-- rolled back and reported in the result, and the next table is still purged. The whole purge is
-- skipped while an analysis is in progress (a CREDORA.RUN_LOG row in the last 3 minutes for a run
-- that has not reached step 13 and has no FAILED row), because RUN_ANALYSIS steps 3 to 6 write the
-- same staging tables as CREDORA_SVC and the two would run into a transaction conflict.
--
-- Who runs it. The Exasol Scheduler (exasol-labs/exasol-scheduler) is a container on the app host
-- (docker-compose.yml, service "scheduler"). It logs in to Exasol as CREDORA_SVC, reads its tasks
-- from SCHED.SCHED_TASKS and writes every run to SCHED.SCHED_HISTORY, both tables in this database
-- (exasol/sql/17_scheduler.sql). Task credora_purge_expired runs this script every 15 minutes. The
-- web app runs it too only if its fallback switch PURGE_INTERVAL_MIN is set (off by default).
--
-- The result has one DELETED row per table and run purged, one FAILED row per table whose purge was
-- rolled back (the error text in DETAIL), or one SKIPPED row when an analysis is in progress.

CREATE OR REPLACE LUA SCRIPT CREDORA.PURGE_EXPIRED() RETURNS TABLE AS
local targets = {
  {t = 'CIBIL_CONSUMER',   key = 'PAN || SCORE || TOTAL_OVERDUE'},
  {t = 'CIBIL_COMMERCIAL', key = 'PAN || CMR_RANK || OVERDUE'},
  {t = 'GST_FILING',       key = 'GSTIN || GST_PERIOD || GSTR1_TURNOVER'},
  {t = 'AA_ACCOUNT',       key = 'PAN || AA_ACCOUNT_ID || CURRENT_BALANCE'},
}
local cols = "table_name VARCHAR(60), run_id VARCHAR(20), rows_deleted DECIMAL(18), status VARCHAR(10), detail VARCHAR(2000)"
local out = {}

-- An analysis in progress writes the same staging tables, so leave the purge to the next schedule.
-- RUN_LOG.LOGGED_AT defaults to CURRENT_TIMESTAMP, so the window is measured on the same clock.
local busy = query([[
  SELECT RUN_ID FROM CREDORA.RUN_LOG
  GROUP BY RUN_ID
  HAVING MAX(LOGGED_AT) >= ADD_MINUTES(CURRENT_TIMESTAMP, -3)
     AND MAX(STEP_NO) < 13
     AND SUM(CASE WHEN STATUS = 'FAILED' THEN 1 ELSE 0 END) = 0]])
if #busy > 0 then
  out[1] = {null, busy[1].RUN_ID, 0, 'SKIPPED', 'Analysis ' .. busy[1].RUN_ID .. ' is in progress, nothing purged'}
  exit(out, cols)
end

-- One cut-off for the whole call, so the rows fingerprinted are exactly the rows deleted.
local cutoff = query([[SELECT TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS.FF3') T FROM DUAL]])[1].T
local due = [[PURGE_AT <= TO_TIMESTAMP(:c, 'YYYY-MM-DD HH24:MI:SS.FF3')]]

for _, x in ipairs(targets) do
  local done = {}
  local ok, err = pcall(function()
    local runs = query([[
      SELECT RUN_ID, CAST(SUM(N) AS DECIMAL(18)) N, HASH_SHA256(LISTAGG(H, '|') WITHIN GROUP (ORDER BY CHUNK_NO)) H
      FROM (SELECT RUN_ID, CHUNK_NO, COUNT(*) N, HASH_SHA256(LISTAGG(K, '|') WITHIN GROUP (ORDER BY K)) H
            FROM (SELECT RUN_ID, ]] .. x.key .. [[ K,
                         FLOOR((ROW_NUMBER() OVER (PARTITION BY RUN_ID ORDER BY ]] .. x.key .. [[) - 1) / 1000) CHUNK_NO
                  FROM CREDORA_STAGE.]] .. x.t .. [[ WHERE ]] .. due .. [[)
            GROUP BY RUN_ID, CHUNK_NO)
      GROUP BY RUN_ID]], {c = cutoff})
    for i = 1, #runs do
      query([[INSERT INTO CREDORA.PURGE_LOG VALUES (SYSTIMESTAMP, :t, :r, :n, :h)]],
            {t = 'CREDORA_STAGE.' .. x.t, r = runs[i].RUN_ID, n = runs[i].N, h = runs[i].H})
      local res = query('DELETE FROM CREDORA_STAGE.' .. x.t .. ' WHERE RUN_ID = :r AND ' .. due,
                        {r = runs[i].RUN_ID, c = cutoff})
      -- The proof must describe exactly the rows that went, or it is no proof.
      if tonumber(res.rows_affected) ~= tonumber(runs[i].N) then
        error('fingerprinted ' .. tostring(runs[i].N) .. ' rows but deleted ' .. tostring(res.rows_affected))
      end
      done[#done + 1] = {x.t, runs[i].RUN_ID, runs[i].N, 'DELETED', null}
    end
    query('COMMIT')
  end)
  if ok then
    for _, row in ipairs(done) do out[#out + 1] = row end
  else
    pquery('ROLLBACK')
    out[#out + 1] = {x.t, null, 0, 'FAILED', string.sub(tostring(err), 1, 2000)}
  end
end
exit(out, cols)
/
