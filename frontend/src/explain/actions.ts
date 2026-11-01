// Explain mode content. Generated from the repo; code excerpts are copied verbatim from the files named.

export interface ActionExplain {
  title: string;
  steps: string[];
  runsAs: string;
  objects: string[];
}

export const ACTION_EXPLAIN: Record<string, ActionExplain> = {
  login: {
    title: "Sign in",
    steps: [
      "The backend checks the app password and issues a token for the role (admin, datasci, loanops or rm).",
      "It maps the role to its Exasol user, which is CREDORA_ADMIN, CREDORA_DATASCI, CREDORA_LOANOPS or CREDORA_RM (backend/app/exa.py ROLE_USER).",
      "From now on every read for this person runs on a pooled pyexasol session logged in as that user, so Exasol's grants decide what comes back.",
      "For the rm login the display name is read from VS_CIF.\"rm\" in the MySQL customer master, as CREDORA_SVC.",
      "The login is written to the CRM audit log (crm.audit_event).",
    ],
    runsAs: "The role's own Exasol user (CREDORA_ADMIN, CREDORA_DATASCI, CREDORA_LOANOPS or CREDORA_RM)",
    objects: ["CREDORA_ADMIN", "CREDORA_DATASCI", "CREDORA_LOANOPS", "CREDORA_RM", "VS_CIF"],
  },
  generate: {
    title: "Generate mock data (replace or append)",
    steps: [
      "The generator service rebuilds Sapphire Bank's synthetic world in the RDS databases. These are Oracle core banking, the MySQL customer master and PostgreSQL loan origination, plus the mock CIBIL, GSTN and AA databases.",
      "Replace starts a new data set. Append adds companies and keeps every name, PAN, GSTIN and account number unique.",
      "Nothing is copied into Exasol. VS_CBS, VS_CIF and VS_LOS read the new rows on the next query, because every query is pushed down to the source.",
      "The next analysis run starts with ALTER VIRTUAL SCHEMA ... REFRESH on all three, so new or rebuilt source tables are seen.",
      "The Sources screen then counts the new rows through the virtual schemas.",
    ],
    runsAs: "Generator service (writes the source databases, not Exasol)",
    objects: ["VS_CBS", "VS_CIF", "VS_LOS"],
  },
  runAnalysis: {
    title: "Run analysis",
    steps: [
      "The backend runs EXECUTE SCRIPT CREDORA.RUN_ANALYSIS('<run>') on its own CREDORA_SVC session and polls CREDORA.RUN_LOG from a second session.",
      "Clean up. Rows of this RUN_ID are deleted from APPLICATIONS, FEATURES, SCORES, ANOMALY, DECISIONS, CHALLENGER_SCORES and RUN_LOG.",
      "1 Refresh virtual schemas. ALTER VIRTUAL SCHEMA VS_CBS, VS_CIF, VS_LOS REFRESH.",
      "2 Read credit needs on file. VS_LOS.\"application\" is joined with VS_CIF.\"company\" and partner counts, pushed down to PostgreSQL and MySQL, into CREDORA.APPLICATIONS.",
      "3 Fetch CIBIL consumer reports (3rd party API). The Python SET UDF CIBIL_CONSUMER_FETCH spreads the PANs over 16 batches (one hex digit of an MD5), and Exasol runs the instances 4 at a time on the 4-core node, each call tried up to 3 times (1 s and 2 s pauses) before the run fails with the service named. It calls through CONNECTION MOCK_CIBIL and writes CREDORA_STAGE.CIBIL_CONSUMER with a 7-day PURGE_AT.",
      "4 Fetch CIBIL commercial reports (3rd party API). CIBIL_COMMERCIAL_FETCH writes CREDORA_STAGE.CIBIL_COMMERCIAL.",
      "5 Fetch GST returns (3rd party API). GST_FETCH calls through CONNECTION MOCK_GSTN and writes CREDORA_STAGE.GST_FILING.",
      "6 Fetch partner accounts at other banks (Account Aggregator API). AA_FETCH calls through CONNECTION MOCK_AA and writes CREDORA_STAGE.AA_ACCOUNT, purged at consent expiry.",
      "7 Compute features. Oracle aggregates transactions per account and month through VS_CBS (pushdown) into CREDORA_STAGE.CA_MONTHLY. CTEs and ROW_NUMBER() then build 13 features into CREDORA.FEATURES.",
      "8 Risk model. Reads the active model from CREDORA.MODEL_REGISTRY. If none exists, it runs CREDORA.TRAIN_MODEL first.",
      "9 Score probability of default (ML UDF). CREDORA.PD_SCORE runs in 4 parallel instances, loads the pickled model from BucketFS after checking its SHA-256 against MODEL_REGISTRY, and writes PD, grade and feature contributions to CREDORA.SCORES.",
      "10 Flag anomalies (Isolation Forest UDF). CREDORA.ANOMALY_FLAG runs over all companies into CREDORA.ANOMALY.",
      "11 Decide offer and negotiation limit. The CREDORA.DECISION_LOGIC SQL reads CREDORA.CONFIG and writes decision, offer, floor ROI, limits and RAROC to CREDORA.DECISIONS.",
      "12 Rank with PREFERRING skyline. Skyline layers run over approved offers, then a MERGE sets RANK_NO and TOP50.",
      "13 Shadow-score with the challenger model. CREDORA.SCORE_CHALLENGER writes CREDORA.CHALLENGER_SCORES and leaves DECISIONS untouched.",
      "Each step writes CREDORA.RUN_LOG and COMMITs, so the screen shows it at once.",
      "Export offers to CRM (crm.offer). The backend reads CREDORA.DECISIONS and upserts the PostgreSQL CRM. Offers already in negotiation keep their terms.",
    ],
    runsAs: "CREDORA_SVC (role R_SVC)",
    objects: ["CREDORA.RUN_ANALYSIS", "CREDORA.RUN_LOG", "VS_CBS", "VS_CIF", "VS_LOS", "CREDORA_STAGE", "CREDORA.FEATURES", "CREDORA.SCORES", "CREDORA.ANOMALY", "CREDORA.DECISIONS", "CREDORA.CHALLENGER_SCORES", "MOCK_CIBIL", "MOCK_GSTN", "MOCK_AA"],
  },
  publishRun: {
    title: "Publish run",
    steps: [
      "The data scientist publishes a finished run to loan operations.",
      "The backend inserts the RUN_ID, who published it and when into CREDORA.RUN_PUBLISH.",
      "CREDORA.V_LATEST_RUN now picks the newest finished run that is also published, so the V_LATEST_* views and CREDORA_SEM.PORTFOLIO switch to it.",
      "The V_RM_* views join RUN_PUBLISH, so relationship managers see this run's results for their companies.",
    ],
    runsAs: "CREDORA_SVC (role R_SVC)",
    objects: ["CREDORA.RUN_PUBLISH", "CREDORA.V_LATEST_RUN", "CREDORA_SEM.PORTFOLIO", "CREDORA.V_RM_DECISIONS"],
  },
  trainModels: {
    title: "Train new model",
    steps: [
      "The backend runs EXECUTE SCRIPT CREDORA.TRAIN_MODEL('<version>').",
      "The champion comes from the Python SET UDF CREDORA.TRAIN_PD. It reads past loans live from PostgreSQL through VS_LOS.\"past_loan_training\" and trains gradient-boosted trees on a 75/25 split.",
      "The challenger comes from CREDORA.TRAIN_SCORECARD, which trains a logistic regression scorecard <version>-lr on the same loans and hold-out.",
      "Each UDF measures AUC, Gini and feature importance, pickles the model and uploads it to BucketFS through CONNECTION BUCKETFS_MODELS (models/pd_<version>.pkl).",
      "Both are inserted into CREDORA.MODEL_REGISTRY. In the same transaction the backend sets IS_ACTIVE back to the model that was active before, so a new model decides nothing until its activation is approved. The very first model stays active.",
      "The latest run is then shadow-scored with the challenger by EXECUTE SCRIPT CREDORA.SCORE_CHALLENGER.",
    ],
    runsAs: "CREDORA_SVC (role R_SVC)",
    objects: ["CREDORA.TRAIN_MODEL", "CREDORA.TRAIN_PD", "CREDORA.TRAIN_SCORECARD", "VS_LOS", "BUCKETFS_MODELS", "CREDORA.MODEL_REGISTRY", "CREDORA.SCORE_CHALLENGER"],
  },
  requestModelActivation: {
    title: "Request model activation",
    steps: [
      "The data scientist picks a trained version, for example the challenger, and sends it to the admin with a note.",
      "The backend reads CREDORA.MODEL_REGISTRY as CREDORA_DATASCI to record the candidate's and the current model's AUC and Gini.",
      "The request is stored as PENDING in the CRM (crm.model_activation_request). Nothing changes in Exasol yet, and the active model keeps deciding.",
    ],
    runsAs: "CREDORA_DATASCI (role R_DATASCI), read-only",
    objects: ["CREDORA.MODEL_REGISTRY"],
  },
  approveModelActivation: {
    title: "Approve model activation",
    steps: [
      "The admin approves with a note. Nobody can decide their own request, and the approval is refused if another model became active since the request.",
      "The backend runs UPDATE CREDORA.MODEL_REGISTRY SET IS_ACTIVE = (MODEL_VERSION = '<version>'), so exactly one model is active.",
      "The next CREDORA.RUN_ANALYSIS scores with this model in step 9. The model it replaced becomes a challenger candidate for step 13.",
    ],
    runsAs: "CREDORA_SVC (role R_SVC)",
    objects: ["CREDORA.MODEL_REGISTRY", "CREDORA.RUN_ANALYSIS"],
  },
  whatIf: {
    title: "What-if run",
    steps: [
      "The data scientist moves the levers, which are the RAROC hurdle, EBLR and the maximum share of GST turnover.",
      "The backend sends one SELECT that replays the decision SQL of RUN_ANALYSIS over the current run's stored CREDORA.FEATURES and CREDORA.SCORES, with the new values in place of CREDORA.CONFIG.",
      "The same query counts APPROVE, REFER and DECLINE before (CREDORA.DECISIONS) and after, with the pre-approved amount.",
      "Nothing is written to Exasol. A saved run is kept in the CRM (crm.whatif_run).",
    ],
    runsAs: "CREDORA_DATASCI (role R_DATASCI)",
    objects: ["CREDORA.CONFIG", "CREDORA.FEATURES", "CREDORA.SCORES", "CREDORA.DECISIONS"],
  },
  proposePolicy: {
    title: "Propose policy",
    steps: [
      "The data scientist sends a saved what-if run to the admin with a note.",
      "The backend reads CREDORA.CONFIG as CREDORA_DATASCI to record the current values, and refuses if they have changed since the what-if.",
      "The proposal is stored as PENDING in crm.policy_proposal. Exasol is not written.",
    ],
    runsAs: "CREDORA_DATASCI (role R_DATASCI), read-only",
    objects: ["CREDORA.CONFIG"],
  },
  approvePolicy: {
    title: "Approve policy",
    steps: [
      "The admin approves with a note. The backend checks CREDORA.CONFIG again as CREDORA_SVC.",
      "The approved policy is written to CREDORA.CONFIG as CREDORA_SVC. One UPDATE changes all moved keys at once.",
      "Then the full official analysis runs, EXECUTE SCRIPT CREDORA.RUN_ANALYSIS('<run>') with all 13 steps, followed by the CRM export.",
      "Decisions, offers, the top 50 and CREDORA_SEM.PORTFOLIO now follow the new policy.",
    ],
    runsAs: "CREDORA_SVC (role R_SVC)",
    objects: ["CREDORA.CONFIG", "CREDORA.RUN_ANALYSIS", "CREDORA.DECISIONS"],
  },
  assignRm: {
    title: "Assign companies to RM",
    steps: [
      "Loan operations picks companies and a relationship manager.",
      "The backend checks the companies are in the published run (CREDORA.DECISIONS), then MERGEs CREDORA.RM_ASSIGNMENT with CIF_ID, RM_ID, EXA_USER (the Exasol user that logs in for that manager, CREDORA_RM for RM001), ASSIGNED_BY and ASSIGNED_AT. There is one row per company, and assigning again moves it.",
      "An ASSIGNED row is added to CREDORA.LOAN_STATUS_LOG for each new or moved company.",
      "The V_RM_* views filter on EXA_USER = REGEXP_REPLACE(CURRENT_USER, '_AI$', ''), so the next query of the manager, or of her AI session user, returns the new book. No app filter is involved.",
    ],
    runsAs: "CREDORA_SVC (role R_SVC)",
    objects: ["CREDORA.RM_ASSIGNMENT", "CREDORA.LOAN_STATUS_LOG", "CREDORA.V_RM_DECISIONS", "CREDORA.V_RM_COMPANY"],
  },
  rmNegotiate: {
    title: "RM negotiate / propose",
    steps: [
      "Each change of amount, ROI or tenure runs one quote query as the RM's own Exasol user.",
      "The query reads the company's decision (PD, product, floor ROI, maximum amount and tenure) and CREDORA.CONFIG, then computes RAROC and the EMI in SQL.",
      "It checks amount <= MAX_AMOUNT, ROI >= FLOOR_ROI, tenure <= MAX_TENURE and RAROC >= HURDLE_PCT.",
      "Propose writes the terms to the CRM. The offer becomes NEGOTIATING if it is inside the limit, or ESCALATED with the reasons if not.",
      "For an RM, Exasol returns only assigned companies through the V_RM_* views.",
    ],
    runsAs: "CREDORA_RM (role R_RM)",
    objects: ["CREDORA.DECISIONS", "CREDORA.CONFIG", "CREDORA.V_RM_DECISIONS"],
  },
  verifySanction: {
    title: "Verify and sanction",
    steps: [
      "Loan operations checks the agreed terms and verifies them with a note. NEGOTIATING or ESCALATED becomes VERIFIED.",
      "A second action sanctions a VERIFIED offer, which becomes SANCTIONED. Reject sends the offer to DECLINED.",
      "Each action is a CRM transition (crm.offer, crm.offer_event) plus an audit entry. Exasol's numbers are not changed, because the run fixed them.",
    ],
    runsAs: "Loan operations in the web app (CRM write). Exasol is not written.",
    objects: ["CREDORA.DECISIONS"],
  },
  logLoanStatus: {
    title: "Log loan status",
    steps: [
      "The RM records where the company is. The statuses are Contacted, Negotiating, Loan taken, In progress, then Disbursed or Not interested.",
      "A note is required. The same status twice, or any change after Disbursed, is refused.",
      "The backend inserts a row into CREDORA.LOAN_STATUS_LOG (CIF_ID, RM_ID, STATUS, NOTE, LOGGED_BY, LOGGED_AT) as CREDORA_SVC and keeps the full history.",
      "The RM reads it back as CREDORA_RM through CREDORA.V_RM_LOAN_STATUS, which joins RM_ASSIGNMENT on CURRENT_USER with the _AI suffix stripped.",
    ],
    runsAs: "CREDORA_SVC (role R_SVC) writes, and CREDORA_RM reads",
    objects: ["CREDORA.LOAN_STATUS_LOG", "CREDORA.V_RM_LOAN_STATUS", "CREDORA.RM_ASSIGNMENT"],
  },
  creditMemo: {
    title: "Credit memo",
    steps: [
      "The backend collects the company's facts from the Exasol report. These are the decision, hard fails, grade, PD, offer, limit and top model drivers.",
      "If CONNECTION AI_LLM exists (checked in EXA_ALL_CONNECTIONS), it runs SELECT CREDORA.CREDIT_MEMO('AI_LLM', <model>, <cif>, <facts>). That Python SCALAR UDF calls Claude from inside Exasol.",
      "Otherwise (for example Claude on Amazon Bedrock) the backend calls the model itself.",
      "The memo is inserted into CREDORA.MEMOS with the model and engine (exasol-udf or backend).",
    ],
    runsAs: "CREDORA_SVC (role R_SVC)",
    objects: ["CREDORA.CREDIT_MEMO", "AI_LLM", "CREDORA.MEMOS", "EXA_ALL_CONNECTIONS"],
  },
  askCredora: {
    title: "Ask Credora question",
    steps: [
      "A topic gate comes first. One Claude call answers IN or OUT, and an OUT question is refused and never reaches Exasol.",
      "The backend starts exasol-mcp-server 2.3.0 over stdio, logged in as the person's own AI session user (CREDORA_RM_AI for the relationship manager), which holds the same role and sits in consumer group CREDORA_AI, where Exasol applies the 60 s statement limit and the 2 GiB temporary memory limit. A role without a configured AI password gets HTTP 503. Writes, BucketFS writes and preprocessor tools are off.",
      "Claude calls MCP tools such as execute_exasol_query, at most 8 per question, starting with CREDORA_SEM.PORTFOLIO.",
      "Exasol's system preprocessor (PREPROC_RT.MASTER) rewrites semantic SQL for the role. Grants limit every query to what the role may read.",
      "The answer is returned with every tool call and its SQL, and the question is written to the audit log.",
    ],
    runsAs: "The person's own AI user, <role user>_AI, through the MCP server",
    objects: ["CREDORA_SEM.PORTFOLIO", "PREPROC_RT.MASTER", "CREDORA_ADMIN_AI", "CREDORA_RM_AI", "CREDORA_AI"],
  },
  purge: {
    title: "Purge",
    steps: [
      "The Exasol Scheduler, a container on the app host logged in as CREDORA_SVC, runs EXECUTE SCRIPT CREDORA.PURGE_EXPIRED() every 15 minutes (SCHED.SCHED_TASKS) and records each run in SCHED.SCHED_HISTORY.",
      "For CIBIL_CONSUMER, CIBIL_COMMERCIAL, GST_FILING and AA_ACCOUNT in CREDORA_STAGE it groups rows past PURGE_AT by RUN_ID.",
      "It sorts the rows by key, cuts them into chunks of 1,000, hashes each chunk with HASH_SHA256 of LISTAGG and writes the row count and the hash of the chunk hashes to CREDORA.PURGE_LOG, because one run's GST rows are above Exasol's 2,000,000-character LISTAGG limit.",
      "Then it deletes those rows, one table per transaction, and skips the whole purge while an analysis logged a step in the last 3 minutes. The Audit and purge screen reads PURGE_LOG.",
    ],
    runsAs: "CREDORA_SVC (role R_SVC)",
    objects: ["CREDORA.PURGE_EXPIRED", "CREDORA_STAGE", "CREDORA.PURGE_LOG"],
  },
  viewReport: {
    title: "View Exasol report",
    steps: [
      "Reads as the signed-in role's Exasol user. It reads the company's row of CREDORA.DECISIONS, its SCORES with feature contributions and the run's RUN_LOG.",
      "Admin, data scientist and loan operations also read CREDORA.FEATURES and CREDORA.ANOMALY.",
      "An RM reads through V_RM_DECISIONS, V_RM_SCORES, V_RM_FEATURES and V_RM_COMPANY, which return a row only if the company is assigned to her Exasol user.",
      "Each RUN_LOG step is shown with the SQL, Lua or Python that ran and its time.",
      "The view is written to the audit log (VIEW_REPORT).",
    ],
    runsAs: "The role's own Exasol user",
    objects: ["CREDORA.DECISIONS", "CREDORA.SCORES", "CREDORA.FEATURES", "CREDORA.ANOMALY", "CREDORA.RUN_LOG", "CREDORA.V_RM_DECISIONS"],
  },
  top50: {
    title: "Top 50",
    steps: [
      "Reads CREDORA.DECISIONS WHERE TOP50 for the current run, ordered by RANK_NO, joined to the masked company view for industry.",
      "TOP50 and RANK_NO were set in step 12 by the PREFERRING skyline layers and a ROW_NUMBER() MERGE.",
      "The CRM adds each offer's stage.",
    ],
    runsAs: "The role's own Exasol user",
    objects: ["CREDORA.DECISIONS", "CREDORA.V_COMPANY_MASKED"],
  },
};
