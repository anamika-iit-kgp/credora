// Job step name -> the Exasol objects it works on, for the job progress screens (Explain mode).
// Matches the backend's step names (backend/app/excerpts.py, jobs.py) and the fixtures' older ones.

export interface StepObject {
  object: string;
  term: string;
}

const RULES: [RegExp, StepObject][] = [
  [/refresh virtual schemas|read bank data/i, { object: "ALTER VIRTUAL SCHEMA VS_CBS, VS_CIF, VS_LOS REFRESH", term: "vs-refresh" }],
  [/credit needs on file|read applications/i, { object: "VS_LOS + VS_CIF pushdown → CREDORA.APPLICATIONS", term: "pushdown" }],
  [/cibil consumer|fetch cibil \(/i, { object: "Python SET UDF CIBIL_CONSUMER_FETCH · CONNECTION MOCK_CIBIL", term: "python-udf" }],
  [/cibil commercial/i, { object: "Python SET UDF CIBIL_COMMERCIAL_FETCH → CREDORA_STAGE", term: "python-udf" }],
  [/fetch gst/i, { object: "Python SET UDF GST_FETCH · CONNECTION MOCK_GSTN", term: "python-udf" }],
  [/account aggregator|fetch aa/i, { object: "Python SET UDF AA_FETCH · CONNECTION MOCK_AA", term: "python-udf" }],
  [/match names/i, { object: "UDF NAME_MATCH", term: "udf" }],
  [/compute features|build features/i, { object: "VS_CBS pushdown → CREDORA_STAGE.CA_MONTHLY → CREDORA.FEATURES", term: "pushdown" }],
  [/^risk model$/i, { object: "CREDORA.MODEL_REGISTRY (active model)", term: "model-registry" }],
  [/score probability|score pd/i, { object: "Python SET UDF CREDORA.PD_SCORE → CREDORA.SCORES", term: "python-udf" }],
  [/anomal/i, { object: "CREDORA.ANOMALY_FLAG → CREDORA.ANOMALY", term: "anomaly-flag" }],
  [/^decide/i, { object: "CREDORA.DECISION_LOGIC + CONFIG → CREDORA.DECISIONS", term: "approve-refer-decline" }],
  [/preferring/i, { object: "PREFERRING skyline + MERGE → DECISIONS.RANK_NO, TOP50", term: "preferring-skyline" }],
  [/shadow-score/i, { object: "CREDORA.SCORE_CHALLENGER → CREDORA.CHALLENGER_SCORES", term: "challenger-model" }],
  [/export offers/i, { object: "CREDORA.DECISIONS → crm.offer (PostgreSQL)", term: "crm" }],
  [/past loans from postgresql/i, { object: "VS_LOS.\"past_loan_training\" pushdown", term: "pushdown" }],
  [/TRAIN_PD/, { object: "Python SET UDF CREDORA.TRAIN_PD", term: "python-udf" }],
  [/TRAIN_SCORECARD/, { object: "Python SET UDF CREDORA.TRAIN_SCORECARD", term: "challenger-model" }],
  [/bucketfs/i, { object: "BUCKETFS_MODELS → CREDORA.MODEL_REGISTRY", term: "bucketfs" }],
  [/clear exasol/i, { object: "CREDORA_STAGE and results", term: "credora-stage" }],
  [/^oracle$|to oracle/i, { object: "RDS Oracle, which Exasol reads in place through VS_CBS", term: "virtual-schema" }],
  [/^mysql$|to mysql/i, { object: "RDS MySQL, which Exasol reads in place through VS_CIF", term: "virtual-schema" }],
  [/^postgres$|to postgresql/i, { object: "RDS PostgreSQL, which Exasol reads in place through VS_LOS", term: "virtual-schema" }],
  [/write official policy|config/i, { object: "UPDATE CREDORA.CONFIG as CREDORA_SVC", term: "policy-config" }],
  [/run_analysis|official analysis/i, { object: "EXECUTE SCRIPT CREDORA.RUN_ANALYSIS", term: "run-analysis" }],
];

export function stepObject(name: string | null | undefined): StepObject | null {
  if (!name) return null;
  for (const [re, o] of RULES) if (re.test(name)) return o;
  return null;
}
