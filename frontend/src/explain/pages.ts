// Explain mode content. Generated from the repo; code excerpts are copied verbatim from the files named.

export interface PageExplain {
  headline: string;
  exasol: string[];
  terms: string[];
}

/** Keyed by the route path in App.tsx ("/" is the overview). */
export const PAGE_EXPLAIN: Record<string, PageExplain> = {
  "/login": {
    headline: "Signing in picks the Exasol user every later query runs as. Each role has one Exasol user.",
    exasol: [
      "admin, datasci, loanops and rm map to CREDORA_ADMIN, CREDORA_DATASCI, CREDORA_LOANOPS and CREDORA_RM.",
      "Exasol grants, not the app, decide what each role can read.",
    ],
    terms: ["user", "role", "grant", "maker-checker"],
  },
  "/": {
    headline: "Counts and the decision mix of the current run, read from CREDORA as your role's Exasol user.",
    exasol: [
      "Decision counts come from CREDORA.DECISIONS grouped by DECISION.",
      "Source health counts tables through VS_CBS, VS_CIF and VS_LOS (pushdown) and the CREDORA tables.",
    ],
    terms: ["approve-refer-decline", "pre-approved-offer", "virtual-schema", "run-analysis"],
  },
  "/companies": {
    headline: "The companies analysed, listed live from the bank's MySQL customer master through VS_CIF, joined with Exasol decisions.",
    exasol: [
      "VS_CIF.\"company\" and VS_CIF.\"partner\" are read in place, and the query is pushed down to MySQL.",
      "An RM sees only assigned companies, through row-filtered views.",
    ],
    terms: ["virtual-schema", "pushdown", "adbc-vs-rs", "rm-assignment", "row-level-security"],
  },
  "/companies/:cif": {
    headline: "One company's data tree, with Oracle, MySQL and PostgreSQL read in parallel through Exasol's virtual schemas.",
    exasol: [
      "Accounts and transactions from VS_CBS (Oracle), partners from VS_CIF (MySQL), the credit need on file from VS_LOS (PostgreSQL).",
      "Each read runs as your role's Exasol user. An RM gets the Exasol view of the company only.",
    ],
    terms: ["virtual-schema", "oracle-vs-adapter", "adbc-vs-rs", "indicated-need", "pan-gstin"],
  },
  "/companies/:cif/report": {
    headline: "Why Exasol decided what it did for this company, with every RUN_ANALYSIS step and its code.",
    exasol: [
      "Reads DECISIONS, SCORES (feature contributions), FEATURES, ANOMALY and RUN_LOG for the current run.",
      "The credit memo runs the CREDIT_MEMO UDF inside Exasol through CONNECTION AI_LLM.",
    ],
    terms: ["exasol-report", "run-log", "pd", "grade", "raroc", "floor-roi", "negotiation-limit", "hard-fail", "anomaly-flag", "credit-memo-udf", "dscr"],
  },
  "/analysis": {
    headline: "EXECUTE SCRIPT CREDORA.RUN_ANALYSIS runs 13 logged steps in one Lua script, shown live from RUN_LOG.",
    exasol: [
      "Runs as CREDORA_SVC. Each step COMMITs its RUN_LOG row so progress shows at once.",
      "Steps cover virtual schema refresh, 3rd party API UDFs, pushdown features, ML scoring, decision SQL, PREFERRING and challenger shadow scoring.",
    ],
    terms: ["run-analysis", "lua-script", "commit-per-step", "run-log", "vs-refresh", "udf", "preferring-skyline", "run-publish"],
  },
  "/analysis/decisions": {
    headline: "Every company's decision of the current run, read from CREDORA.DECISIONS.",
    exasol: [
      "Filters and paging run as SQL in Exasol as your role's user.",
    ],
    terms: ["approve-refer-decline", "hard-fail", "grade", "pd", "raroc", "kyc"],
  },
  "/analysis/top50": {
    headline: "The 50 best offers, ranked by Exasol's PREFERRING skyline, which finds the best on return, risk and amount at once.",
    exasol: [
      "Reads CREDORA.DECISIONS WHERE TOP50, set by step 12 with skyline layers and a ROW_NUMBER() MERGE.",
    ],
    terms: ["top-50", "preferring-skyline", "rank", "raroc", "pd", "window-functions", "merge"],
  },
  "/models": {
    headline: "Risk models trained and scored inside Exasol by Python UDFs, stored in BucketFS, listed in MODEL_REGISTRY.",
    exasol: [
      "Train runs CREDORA.TRAIN_MODEL as CREDORA_SVC on past loans read live through VS_LOS.",
      "Champion vs challenger compares CREDORA.SCORES with CREDORA.CHALLENGER_SCORES for the same run.",
    ],
    terms: ["model-registry", "risk-model", "challenger-model", "model-activation", "model-activation-approval", "pickle-model", "bucketfs", "omp-num-threads"],
  },
  "/models/whatif": {
    headline: "One Exasol query replays the decision SQL with new policy values. Nothing is written.",
    exasol: [
      "Runs as CREDORA_DATASCI over the current run's FEATURES and SCORES, overriding CREDORA.CONFIG in a CTE.",
      "A saved run can be proposed to the admin as new policy.",
    ],
    terms: ["what-if", "policy-config", "policy-proposal", "hurdle-rate", "eblr", "working-capital"],
  },
  "/ask": {
    headline: "Claude queries Exasol through the Exasol MCP server, logged in as your own AI session user (your role user with the _AI suffix, in consumer group CREDORA_AI).",
    exasol: [
      "Claude tries the semantic view CREDORA_SEM.PORTFOLIO first, then plain SQL where your grants allow.",
      "Every tool call and its SQL is shown with the answer.",
    ],
    terms: ["ask-credora", "exasol-mcp-server", "topic-gate", "mcp-tool-call", "semantic-view", "certified-metric", "sql-preprocessor"],
  },
  "/pipeline": {
    headline: "Offers exported from CREDORA.DECISIONS to the CRM after each run, by stage.",
    exasol: [
      "Offer terms and limits come from Exasol. Stages and negotiation are kept in the CRM.",
    ],
    terms: ["offer-stages", "crm", "pre-approved-offer", "negotiation-limit", "loan-status"],
  },
  "/offers/:offerId": {
    headline: "Each change of terms runs a quote query in Exasol that computes RAROC and EMI and checks the limits against the decision row.",
    exasol: [
      "Runs as the RM's Exasol user and reads DECISIONS and CONFIG.",
      "Inside the limit the offer is NEGOTIATING. Outside it, the offer is ESCALATED.",
    ],
    terms: ["negotiation-limit", "floor-roi", "raroc", "hurdle-rate", "term-loan", "working-capital", "maker-checker", "loan-status"],
  },
  "/queue": {
    headline: "Loan operations checks offers the RMs negotiated. Exasol's limits travel with each offer.",
    exasol: [
      "Verify and sanction change the CRM only. The analysis run fixed the numbers.",
    ],
    terms: ["maker-checker", "offer-stages", "loan-operations", "negotiation-limit", "disbursal"],
  },
  "/admin/data": {
    headline: "The generator rebuilds the source databases, and Exasol reads them in place through virtual schemas.",
    exasol: [
      "Nothing is loaded into Exasol. The next run refreshes the virtual schemas first.",
    ],
    terms: ["mock-data", "virtual-schema", "vs-refresh", "rds"],
  },
  "/admin/sources": {
    headline: "Row counts of all seven sources, counted through Exasol. They are three virtual schemas, three 3rd party data APIs and CREDORA.",
    exasol: [
      "COUNT(*) on VS_CBS, VS_CIF and VS_LOS is pushed down to Oracle, MySQL and PostgreSQL.",
    ],
    terms: ["virtual-schema", "pushdown", "oracle-vs-adapter", "adbc-vs-rs", "connection-object", "cibil-consumer", "gstn", "account-aggregator"],
  },
  "/admin/audit": {
    headline: "Raw 3rd party data, fetched on demand via API, is deleted on time by CREDORA.PURGE_EXPIRED, with row counts and SHA-256 fingerprints.",
    exasol: [
      "Reads CREDORA.PURGE_LOG. The purge itself runs as CREDORA_SVC.",
    ],
    terms: ["purge-proof", "credora-stage", "consent", "audit-log"],
  },
  "/admin/policy": {
    headline: "Approving a policy writes CREDORA.CONFIG as CREDORA_SVC, then runs the full CREDORA.RUN_ANALYSIS.",
    exasol: [
      "One UPDATE changes all approved keys, and the official run follows the new policy.",
    ],
    terms: ["policy-proposal", "policy-config", "maker-checker", "run-analysis", "hurdle-rate", "eblr"],
  },
  "/admin/approvals": {
    headline: "Maker-checker for the two things that change decisions. An approved policy writes CREDORA.CONFIG, and an approved activation switches MODEL_REGISTRY.IS_ACTIVE.",
    exasol: [
      "Both writes run as CREDORA_SVC, and the role users stay read-only in Exasol.",
      "An approved policy then runs the full CREDORA.RUN_ANALYSIS and publishes it. An activated model scores from the next run on.",
    ],
    terms: ["maker-checker", "policy-proposal", "policy-config", "model-activation-approval", "model-registry", "credora-svc"],
  },
  "/book": {
    headline: "Your companies only. The V_RM_* views return rows assigned to your Exasol user, CREDORA_RM, and nothing else.",
    exasol: [
      "The views join CREDORA.RM_ASSIGNMENT on EXA_USER = REGEXP_REPLACE(CURRENT_USER, '_AI$', ''), so the filter lives in the database, not in the app, and your AI session user sees the same book.",
      "Each status you log is a row in CREDORA.LOAN_STATUS_LOG, written as CREDORA_SVC. You read it back through V_RM_LOAN_STATUS.",
    ],
    terms: ["row-level-security", "current-user", "rm-assignment", "loan-status", "pre-approved-offer"],
  },
  "/status": {
    headline: "Every assigned company and its latest loan status, from CREDORA.RM_ASSIGNMENT and CREDORA.LOAN_STATUS_LOG.",
    exasol: [
      "Assignments are MERGEd into RM_ASSIGNMENT as CREDORA_SVC, and the full status history is kept.",
    ],
    terms: ["rm-assignment", "loan-status", "merge", "disbursal"],
  },
  "/exasol": {
    headline: "The database itself, read from Exasol's system tables with your own Exasol user. Anything missing here is something your grants hide.",
    exasol: [
      "EXA_ALL_* views list only the objects your user may see. The admin also reads EXA_DBA_* through SELECT ANY DICTIONARY.",
      "A refused panel is Exasol saying no to your role, which is the security model at work.",
    ],
    terms: ["system-tables", "grant", "role", "select-any-dictionary", "virtual-schema", "slc", "sql-preprocessor", "semantic-view", "model-registry"],
  },
  "/glossary": {
    headline: "Every term the app uses, each with what it means in Exasol, the objects and code behind it and its documentation.",
    exasol: [],
    terms: ["virtual-schema", "udf", "preferring-skyline", "semantic-view", "row-level-security"],
  },
};
