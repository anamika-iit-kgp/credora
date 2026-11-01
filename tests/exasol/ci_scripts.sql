-- Test-only script for the docker-db check (tests/exasol/run_docker_db.py). Dropped after the run.
--
-- CREDORA.CI_DECIDE_AND_RANK(run_id) is steps 11 and 12 of CREDORA.RUN_ANALYSIS
-- (exasol/lua/06_run_analysis.sql) on their own: the decision SQL of CREDORA.DECISION_LOGIC on
-- the run's scores, then the PREFERRING skyline ranking and the Top 50. Steps 1 to 10 need the
-- virtual schemas, the API UDFs and a model file in BucketFS, which docker-db does not have, so
-- the fixture rows (fixtures.sql) stand in for their output and this script picks up from there.
-- Keep it in step with those two steps of RUN_ANALYSIS.

CREATE OR REPLACE LUA SCRIPT CREDORA.CI_DECIDE_AND_RANK(run_id) RETURNS TABLE AS
import('CREDORA.DECISION_LOGIC', 'logic')
local p = {r = run_id}
query([[DELETE FROM CREDORA.DECISIONS WHERE RUN_ID = :r]], p)
local decided = query([[
  INSERT INTO CREDORA.DECISIONS (RUN_ID, APP_ID, CIF_ID, LEGAL_NAME, RM_ID, PRODUCT, AMOUNT_REQUESTED,
    TENURE_REQUESTED, DECISION, HARD_FAILS, GRADE, PD, OFFER_AMOUNT, OFFER_ROI, OFFER_TENURE, FLOOR_ROI,
    MAX_AMOUNT, MAX_TENURE, RAROC_OFFER, RAROC_FLOOR)
  ]] .. logic.decide('CREDORA.SCORES'), p).rows_affected or 0
local layer, ranked = 0, 0
while ranked < 50 and layer < 30 do
  layer = layer + 1
  local res = query([[
    UPDATE CREDORA.DECISIONS SET SKYLINE_LAYER = :l
    WHERE RUN_ID = :r AND APP_ID IN (
      SELECT APP_ID FROM CREDORA.DECISIONS
      WHERE RUN_ID = :r AND DECISION = 'APPROVE' AND SKYLINE_LAYER IS NULL
      PREFERRING HIGH RAROC_OFFER PLUS LOW PD PLUS HIGH OFFER_AMOUNT)]], {r = run_id, l = layer})
  if (res.rows_affected or 0) == 0 then break end
  ranked = ranked + res.rows_affected
end
query([[
  MERGE INTO CREDORA.DECISIONS d USING (
    SELECT APP_ID, ROW_NUMBER() OVER (ORDER BY CASE DECISION WHEN 'APPROVE' THEN 1 WHEN 'REFER' THEN 2 ELSE 3 END,
                                               COALESCE(SKYLINE_LAYER, 999), PD, RAROC_OFFER DESC) RN
    FROM CREDORA.DECISIONS WHERE RUN_ID = :r) x
  ON d.APP_ID = x.APP_ID AND d.RUN_ID = :r
  WHEN MATCHED THEN UPDATE SET RANK_NO = x.RN, TOP50 = (x.RN <= 50 AND d.DECISION = 'APPROVE')]], p)
query('COMMIT')
exit({{decided, ranked, layer}}, "decided DECIMAL(10), ranked DECIMAL(10), layers DECIMAL(10)")
/
