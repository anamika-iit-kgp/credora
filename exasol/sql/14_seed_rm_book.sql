-- Demo seed: give relationship manager RM001 (Exasol user CREDORA_RM, the "rm" demo login) a book,
-- so that login is not empty before loan operations has assigned anything.
--
-- Takes the 25 best-ranked pre-approved (APPROVE) companies of the Top 50 in the latest published
-- run. Idempotent: does nothing once RM001 has any assignment, and never moves a company that loan
-- operations has already assigned to someone else.
--
-- Run it with: python deploy/credora.py rm-book <env>   (the deploy tool also runs it after the
-- first analysis of a new deployment).

INSERT INTO CREDORA.RM_ASSIGNMENT (CIF_ID, RM_ID, EXA_USER, ASSIGNED_BY, ASSIGNED_AT)
SELECT d.CIF_ID, 'RM001', 'CREDORA_RM', 'seed', SYSTIMESTAMP
FROM CREDORA.DECISIONS d
JOIN CREDORA.V_LATEST_RUN r ON r.RUN_ID = d.RUN_ID
WHERE d.TOP50 AND d.DECISION = 'APPROVE'
  AND NOT EXISTS (SELECT 1 FROM CREDORA.RM_ASSIGNMENT x WHERE x.CIF_ID = d.CIF_ID)
  AND NOT EXISTS (SELECT 1 FROM CREDORA.RM_ASSIGNMENT x WHERE x.RM_ID = 'RM001')
ORDER BY d.RANK_NO
LIMIT 25;
