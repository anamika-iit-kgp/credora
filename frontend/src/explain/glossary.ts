// Explain mode content. Generated from the repo; code excerpts are copied verbatim from the files named.

export interface Term {
  id: string;
  term: string;
  kind: "exasol" | "banking" | "ai" | "aws" | "app";
  plain: string;
  inExasol?: string;
  objects?: string[];
  code?: { lang: "sql" | "lua" | "python" | "text"; snippet: string; file: string };
  docs?: string;
  related?: string[];
}

export const GLOSSARY: Record<string, Term> = {
  "virtual-schema": {
    id: "virtual-schema",
    term: "Virtual schema",
    kind: "exasol",
    plain: "A schema in Exasol whose tables really live in another database. You query it like any Exasol schema, and the data stays where it is.",
    inExasol: "VS_CBS reads Oracle core banking, VS_CIF reads the MySQL customer master and VS_LOS reads PostgreSQL loan origination. No bank data is copied into Exasol. Each query is sent to the source database.",
    objects: ["VS_CBS", "VS_CIF", "VS_LOS", "ORA_CBS", "MYSQL_CIF", "PG_LOS"],
    code: {
      lang: "sql",
      file: "exasol/sql/03_virtual_schemas.sql",
      snippet: `CREATE VIRTUAL SCHEMA IF NOT EXISTS VS_CBS USING ADAPTER.ORACLE_ADAPTER WITH
  CONNECTION_NAME = 'ORA_CBS'
  SCHEMA_NAME     = 'CBS';`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/virtual_schemas.htm",
    related: ["pushdown", "vs-refresh", "oracle-vs-adapter", "adbc-vs-rs", "connection-object"],
  },
  "pushdown": {
    id: "pushdown",
    term: "Pushdown",
    kind: "exasol",
    plain: "Exasol hands filters, joins and sums to the source database, so only the result travels back, not every raw row.",
    inExasol: "Step 7 of CREDORA.RUN_ANALYSIS (Compute features) groups about 850,000 Oracle transactions per account and month through VS_CBS. Oracle does the join, the filter and the GROUP BY, and about 19,000 monthly totals come back to CREDORA_STAGE.CA_MONTHLY. EXPLAIN VIRTUAL on the Sources screen shows the exact SQL Oracle receives.",
    objects: ["VS_CBS.TXN", "VS_CBS.ACCOUNT", "CREDORA_STAGE.CA_MONTHLY"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `query([[INSERT INTO CREDORA_STAGE.CA_MONTHLY
        SELECT m.ACCOUNT_NO, m.CIF_ID, TO_TIMESTAMP(m.MON || '-01', 'YYYY-MM-DD'), m.CREDITS, m.DEBITS,
               m.BOUNCES, m.BAL_SUM, m.N
        FROM (SELECT t.ACCOUNT_NO, a.OWNER_ID CIF_ID, TO_CHAR(t.TXN_DATE, 'YYYY-MM') MON,
                     SUM(CASE WHEN t.DR_CR = 'C' THEN t.AMOUNT ELSE 0 END) CREDITS,
                     SUM(CASE WHEN t.DR_CR = 'D' THEN 1 ELSE 0 END) DEBITS,
                     SUM(CASE WHEN t.BOUNCED = 'Y' THEN 1 ELSE 0 END) BOUNCES,
                     SUM(t.BALANCE_AFTER) BAL_SUM, COUNT(*) N
              FROM VS_CBS.TXN t JOIN VS_CBS.ACCOUNT a ON a.ACCOUNT_NO = t.ACCOUNT_NO
              WHERE a.OWNER_TYPE = 'COMPANY' AND a.ACCT_TYPE = 'CA'
              GROUP BY t.ACCOUNT_NO, a.OWNER_ID, TO_CHAR(t.TXN_DATE, 'YYYY-MM')) m]])`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/virtual_schemas.htm",
    related: ["virtual-schema", "run-analysis", "explain-virtual"],
  },
  "vs-refresh": {
    id: "vs-refresh",
    term: "Virtual schema refresh",
    kind: "exasol",
    plain: "A virtual schema remembers the list of tables and columns in the source. A refresh reads that list again, so new or rebuilt tables are seen.",
    inExasol: "Step 1 of CREDORA.RUN_ANALYSIS runs ALTER VIRTUAL SCHEMA ... REFRESH on VS_CBS, VS_CIF and VS_LOS as CREDORA_SVC. R_SVC holds the system privilege ALTER ANY VIRTUAL SCHEMA REFRESH for this.",
    objects: ["VS_CBS", "VS_CIF", "VS_LOS", "R_SVC"],
    code: {
      lang: "lua",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `step(1, 'Refresh virtual schemas', function()
  for _, vs in ipairs({'VS_CBS', 'VS_CIF', 'VS_LOS'}) do
    query('ALTER VIRTUAL SCHEMA ' .. vs .. ' REFRESH')
  end
  return 3
end)`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/alter_schema.htm",
    related: ["virtual-schema", "run-analysis"],
  },
  "oracle-vs-adapter": {
    id: "oracle-vs-adapter",
    term: "Oracle virtual schema adapter",
    kind: "exasol",
    plain: "The plug-in that teaches Exasol to talk to Oracle. It turns Exasol queries into Oracle SQL.",
    inExasol: "ADAPTER.ORACLE_ADAPTER is a JAVA ADAPTER SCRIPT (Exasol's oracle-virtual-schema 6.0.0) with the ojdbc17 JDBC driver, both stored in BucketFS. VS_CBS uses it with CONNECTION ORA_CBS, logging in to Oracle as the read-only user CREDORA_RO.",
    objects: ["ADAPTER.ORACLE_ADAPTER", "VS_CBS", "ORA_CBS"],
    code: {
      lang: "python",
      file: "deploy/exasol_setup.py",
      snippet: "c.execute(\"CREATE OR REPLACE JAVA ADAPTER SCRIPT ADAPTER.ORACLE_ADAPTER AS\\n\"\n          \"  %scriptclass com.exasol.adapter.RequestDispatcher;\\n\"\n          f\"  %jar {b}/vs/{ORACLE_VS_JAR};\\n\"\n          f\"  %jar {b}/drivers/jdbc/ojdbc17.jar;\\n/\\n\")",
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/virtual_schemas.htm",
    related: ["virtual-schema", "slc", "bucketfs", "rds"],
  },
  "adbc-vs-rs": {
    id: "adbc-vs-rs",
    term: "adbc-vs-rs",
    kind: "exasol",
    plain: "An open-source virtual schema adapter from exasol-labs, written in Rust. One adapter reads both MySQL and PostgreSQL.",
    inExasol: "ADBC_VS.ADBC_ADAPTER (a RUST ADAPTER SCRIPT, v0.7.0) and its scan UDF ADBC_VS.ADBC_SCAN load udf/libadbc_vs_adapter.so from BucketFS. It moves Arrow record batches through ADBC drivers that it downloads into BucketFS on first use (CONNECTION ADBC_VS_BUCKETFS).",
    objects: ["ADBC_VS.ADBC_ADAPTER", "ADBC_VS.ADBC_SCAN", "VS_CIF", "VS_LOS", "ADBC_VS_BUCKETFS"],
    code: {
      lang: "sql",
      file: "exasol/sql/03_virtual_schemas.sql",
      snippet: `CREATE VIRTUAL SCHEMA IF NOT EXISTS VS_CIF USING ADBC_VS.ADBC_ADAPTER WITH
  DRIVER          = 'mysql'
  CONNECTION_NAME = 'MYSQL_CIF';`,
    },
    related: ["virtual-schema", "slc", "bucketfs"],
  },
  "slc": {
    id: "slc",
    term: "Script Language Container (SLC)",
    kind: "exasol",
    plain: "A packaged runtime that lets Exasol run code in a language such as Python, Java or Rust right next to the data.",
    inExasol: "The 3rd party API, ML and AI UDFs run in the built-in PYTHON3 language. The Oracle adapter runs in Java. For adbc-vs-rs the deploy tool uploads the Rust SLC 0.23.1 to BucketFS (slc/rustslc.tar.gz) and registers it as RUST with ALTER SYSTEM SET SCRIPT_LANGUAGES.",
    objects: ["PYTHON3", "JAVA", "RUST"],
    code: {
      lang: "python",
      file: "deploy/exasol_setup.py",
      snippet: `def install_rust_slc(ex: Exasol) -> None:
    """Rust language container pinned to the SDK version adbc-vs-rs was built with."""
    if "slc/rustslc.tar.gz" not in ex.bfs_list():
        print("  uploading Rust SLC")
        ex.bfs_put("slc/rustslc.tar.gz", fetch("lc-rust.tar.gz"))
    ex.bfs_extracted("slc/rustslc/exaudf/exaudfclient")
    alias = (f"RUST=localzmq+protobuf:///bfsdefault/{ex.bucket}/slc/rustslc?lang=rust"
             f"#buckets/bfsdefault/{ex.bucket}/slc/rustslc/exaudf/exaudfclient")
    register_language(ex, "RUST", alias)`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/udf_scripts/adding_new_packages_script_languages.htm",
    related: ["udf", "bucketfs", "adbc-vs-rs"],
  },
  "bucketfs": {
    id: "bucketfs",
    term: "BucketFS",
    kind: "exasol",
    plain: "Exasol's own file store, copied to every node. Code that runs inside the database reads files from it like a local disk.",
    inExasol: "Bucket default of bfsdefault holds the Rust SLC, the adbc-vs-rs library, the ADBC drivers, the Oracle adapter jar, ojdbc17 and every trained model (models/pd_<version>.pkl). The training UDFs upload over HTTPS on port 2581 through CONNECTION BUCKETFS_MODELS. Scoring UDFs read /buckets/bfsdefault/default/models/.",
    objects: ["BUCKETFS_MODELS", "ADBC_VS_BUCKETFS"],
    code: {
      lang: "python",
      file: "exasol/udf/05_ml_udfs.sql",
      snippet: `conn = exa.get_connection("BUCKETFS_MODELS")
path = f"pd_{version}.pkl"
r = requests.put(f"{conn.address}/{path}", data=buf.getvalue(), auth=(conn.user, conn.password),
                 verify=False, timeout=120)
r.raise_for_status()
ctx.emit(version, "Gradient-boosted trees (scikit-learn HistGradientBoosting, monotonic)", auc, 2 * auc - 1,`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/bucketfs/bucketfs.htm",
    related: ["pickle-model", "slc", "model-registry"],
  },
  "udf": {
    id: "udf",
    term: "UDF (user defined function)",
    kind: "exasol",
    plain: "Your own function, written in a language like Python, that you call from SQL. Exasol runs it in parallel inside the database.",
    inExasol: "Credora's UDFs fetch CIBIL, GST and Account Aggregator data (CIBIL_CONSUMER_FETCH, CIBIL_COMMERCIAL_FETCH, GST_FETCH, AA_FETCH), train and score models (TRAIN_PD, TRAIN_SCORECARD, PD_SCORE, ANOMALY_FLAG) and write credit memos (CREDIT_MEMO), all in schema CREDORA.",
    objects: ["CREDORA.GST_FETCH", "CREDORA.PD_SCORE", "CREDORA.TRAIN_PD", "CREDORA.CREDIT_MEMO"],
    code: {
      lang: "sql",
      file: "exasol/udf/04_api_udfs.sql",
      snippet: `CREATE OR REPLACE PYTHON3 SET SCRIPT CREDORA.GST_FETCH(conn_name VARCHAR(100), gstin VARCHAR(15))
EMITS (gstin VARCHAR(15), legal_name VARCHAR(120), pan VARCHAR(10), state_name VARCHAR(30), registered_on DATE,
       reg_status VARCHAR(10), stage VARCHAR(12), gst_period VARCHAR(7), gstr1_turnover DOUBLE,
       gstr3b_tax_paid DOUBLE, due_date DATE, filed_on DATE, delay_days DOUBLE) AS`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/udf_scripts.htm",
    related: ["scalar-vs-set-udf", "python-udf", "slc"],
  },
  "scalar-vs-set-udf": {
    id: "scalar-vs-set-udf",
    term: "SCALAR vs SET UDF",
    kind: "exasol",
    plain: "A SCALAR UDF handles one row at a time. A SET UDF gets a whole group of rows at once, which suits bulk API calls and model training.",
    inExasol: "The fetch, training and scoring UDFs are SET scripts. GROUP BY SUBSTR(HASH_MD5(key), 1, 1) splits the keys into 16 groups, so 16 instances run in parallel. PD_SCORE uses 4 groups, one per core. CREDORA.CREDIT_MEMO is a SCALAR script that EMITS one memo per company row.",
    objects: ["CREDORA.CIBIL_CONSUMER_FETCH", "CREDORA.PD_SCORE", "CREDORA.CREDIT_MEMO"],
    code: {
      lang: "sql",
      file: "exasol/udf/09_ai_udf.sql",
      snippet: `CREATE OR REPLACE PYTHON3 SCALAR SCRIPT CREDORA.CREDIT_MEMO(
  conn_name VARCHAR(100), model VARCHAR(80), cif_id VARCHAR(8), facts VARCHAR(20000))
EMITS (cif_id VARCHAR(8), memo VARCHAR(20000)) AS`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/udf_scripts/udf_overview.htm",
    related: ["udf", "python-udf"],
  },
  "python-udf": {
    id: "python-udf",
    term: "Python UDF",
    kind: "exasol",
    plain: "A UDF written in Python 3. It can use libraries such as requests and scikit-learn.",
    inExasol: "Credora's Python UDFs run in the PYTHON3 language. They read credentials with exa.get_connection() and loop over their input rows with ctx.next() or ctx.get_dataframe().",
    objects: ["CREDORA.CIBIL_CONSUMER_FETCH", "CREDORA.TRAIN_PD", "CREDORA.ANOMALY_FLAG"],
    code: {
      lang: "python",
      file: "exasol/udf/04_api_udfs.sql",
      snippet: `def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    pans = keys(ctx, "pan")
    for i in range(0, len(pans), 500):
        r = requests.post(f"{conn.address}/v1/consumer/bulk", json={"pans": pans[i:i + 500]},
                          headers={"X-API-Key": conn.password}, timeout=120)
        r.raise_for_status()`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/udf_scripts/python3.htm",
    related: ["udf", "connection-object", "scalar-vs-set-udf"],
  },
  "lua-script": {
    id: "lua-script",
    term: "Lua script (Exasol scripting)",
    kind: "exasol",
    plain: "A program stored in the database that runs SQL statements one after another, with loops, error handling and logging.",
    inExasol: "CREDORA.RUN_ANALYSIS runs the whole daily analysis in one EXECUTE SCRIPT call. TRAIN_MODEL, SCORE_CHALLENGER and PURGE_EXPIRED are Lua scripts too. CREDORA.DECISION_LOGIC is a Lua library that RUN_ANALYSIS and SCORE_CHALLENGER load with import().",
    objects: ["CREDORA.RUN_ANALYSIS", "CREDORA.TRAIN_MODEL", "CREDORA.DECISION_LOGIC", "CREDORA.PURGE_EXPIRED"],
    code: {
      lang: "lua",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `local function step(no, name, fn)
  local t0 = now()
  local ok, res = pcall(fn)
  if ok then
    log(no, name, 'OK', res or 0, t0, null)
    query('COMMIT')  -- make each finished step visible to the web app at once
  else
    log(no, name, 'FAILED', 0, t0, string.sub(tostring(res), 1, 1900))
    error(res)
  end
end`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/scripting.htm",
    related: ["run-analysis", "commit-per-step", "run-log"],
  },
  "commit-per-step": {
    id: "commit-per-step",
    term: "COMMIT per step",
    kind: "exasol",
    plain: "Each finished step is saved for good at once, so others can see progress while the job is still running.",
    inExasol: "After each step RUN_ANALYSIS writes a row to CREDORA.RUN_LOG and runs COMMIT. The web app polls RUN_LOG about every 0.8 s from a second session and shows each step as it finishes.",
    objects: ["CREDORA.RUN_LOG", "CREDORA.RUN_ANALYSIS"],
    code: {
      lang: "lua",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `if ok then
  log(no, name, 'OK', res or 0, t0, null)
  query('COMMIT')  -- make each finished step visible to the web app at once`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/transaction_management.htm",
    related: ["lua-script", "run-log", "sessions"],
  },
  "connection-object": {
    id: "connection-object",
    term: "CONNECTION object",
    kind: "exasol",
    plain: "A named, stored address with a user and password. SQL refers to it by name, so secrets never appear in queries.",
    inExasol: "ORA_CBS, MYSQL_CIF and PG_LOS hold the bank databases. MOCK_CIBIL, MOCK_GSTN and MOCK_AA hold the addresses and token of the 3rd party data APIs. BUCKETFS_MODELS and AI_LLM hold the BucketFS and Claude keys. Only R_SVC is granted ACCESS on the 3rd party API, BucketFS and AI connections.",
    objects: ["ORA_CBS", "MYSQL_CIF", "PG_LOS", "MOCK_CIBIL", "MOCK_GSTN", "MOCK_AA", "BUCKETFS_MODELS", "AI_LLM"],
    code: {
      lang: "sql",
      file: "exasol/sql/02_connections.sql",
      snippet: "CREATE OR REPLACE CONNECTION MOCK_CIBIL\n  TO '${MOCK_CIBIL_URL}' USER 'api' IDENTIFIED BY '${MOCK_API_TOKEN}';",
    },
    docs: "https://docs.exasol.com/db/latest/sql/create_connection.htm",
    related: ["grant", "python-udf", "credit-memo-udf"],
  },
  "preferring-skyline": {
    id: "preferring-skyline",
    term: "PREFERRING (skyline)",
    kind: "exasol",
    plain: "An Exasol SQL clause that keeps only the rows no other row beats on every chosen measure at once. No weights are needed.",
    inExasol: "Step 12 of RUN_ANALYSIS runs PREFERRING HIGH RAROC_OFFER PLUS LOW PD PLUS HIGH OFFER_AMOUNT over approved companies, layer after layer, and stores the layer in DECISIONS.SKYLINE_LAYER until at least 50 are ranked. The best 50 get TOP50 = TRUE.",
    objects: ["CREDORA.DECISIONS"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `UPDATE CREDORA.DECISIONS SET SKYLINE_LAYER = :l
WHERE RUN_ID = :r AND APP_ID IN (
  SELECT APP_ID FROM CREDORA.DECISIONS
  WHERE RUN_ID = :r AND DECISION = 'APPROVE' AND SKYLINE_LAYER IS NULL
  PREFERRING HIGH RAROC_OFFER PLUS LOW PD PLUS HIGH OFFER_AMOUNT)]], {r = run_id, l = layer})`,
    },
    docs: "https://docs.exasol.com/db/latest/advanced_analytics/skyline.htm",
    related: ["top-50", "raroc", "pd"],
  },
  "window-functions": {
    id: "window-functions",
    term: "Window functions",
    kind: "exasol",
    plain: "SQL functions that look at neighbouring rows, such as numbering rows in order, without collapsing them into one.",
    inExasol: "Step 7 numbers each company's GST returns newest first with ROW_NUMBER() OVER (PARTITION BY ...) to keep the last 12. Step 12 numbers all decisions with ROW_NUMBER() OVER (ORDER BY ...) to set RANK_NO.",
    objects: ["CREDORA.FEATURES", "CREDORA.DECISIONS"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `gst_ranked AS (
  SELECT app.APP_ID, g.*, ROW_NUMBER() OVER (PARTITION BY app.APP_ID ORDER BY g.GST_PERIOD DESC) RN
  FROM app JOIN CREDORA_STAGE.GST_FILING g ON g.GSTIN = app.GSTIN AND g.RUN_ID = :r
  WHERE g.GST_PERIOD < app.AS_OF_PERIOD),`,
    },
    docs: "https://docs.exasol.com/db/latest/sql_references/functions/analyticfunctions.htm",
    related: ["run-analysis"],
  },
  "merge": {
    id: "merge",
    term: "MERGE",
    kind: "exasol",
    plain: "One SQL statement that updates matching rows and inserts missing ones.",
    inExasol: "Step 12 MERGEs RANK_NO and TOP50 into CREDORA.DECISIONS. SCORE_CHALLENGER MERGEs the challenger's decision into CREDORA.CHALLENGER_SCORES. 01_schemas.sql seeds CREDORA.CONFIG with MERGE so existing policy values are kept.",
    objects: ["CREDORA.DECISIONS", "CREDORA.CHALLENGER_SCORES", "CREDORA.CONFIG"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `  MERGE INTO CREDORA.DECISIONS d USING (
    SELECT APP_ID, ROW_NUMBER() OVER (ORDER BY CASE DECISION WHEN 'APPROVE' THEN 1 WHEN 'REFER' THEN 2 ELSE 3 END,
                                               COALESCE(SKYLINE_LAYER, 999), PD, RAROC_OFFER DESC) RN
    FROM CREDORA.DECISIONS WHERE RUN_ID = :r) x
  ON d.APP_ID = x.APP_ID AND d.RUN_ID = :r
  WHEN MATCHED THEN UPDATE SET RANK_NO = x.RN, TOP50 = (x.RN <= 50 AND d.DECISION = 'APPROVE')]], p)
return ranked`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/merge.htm",
    related: ["preferring-skyline"],
  },
  "semantic-view": {
    id: "semantic-view",
    term: "Semantic view (exasol-semantic-views)",
    kind: "exasol",
    plain: "A business-friendly layer over tables, with named metrics and dimensions that everyone, people and AI, queries the same way.",
    inExasol: "CREDORA_SEM.PORTFOLIO is built with exasol-labs/exasol-semantic-views v0.5.1 over the V_LATEST_* views, with one row per company of the latest published run. Its dimensions include industry, grade, decision and rm_id, and its metrics include approved_companies, approval_rate and pre_approved_amount.",
    objects: ["CREDORA_SEM.PORTFOLIO", "CREDORA.V_LATEST_DECISION", "CREDORA.V_LATEST_COMPANY"],
    code: {
      lang: "sql",
      file: "exasol/semantic/12_credora_model.sql",
      snippet: `EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_SEMANTIC_OBJECT('credora', 'PORTFOLIO', 'company',
  'Pre-approved offer portfolio of the latest completed analysis run: one row per company');`,
    },
    related: ["certified-metric", "sql-preprocessor", "latest-run-views", "ask-credora"],
  },
  "certified-metric": {
    id: "certified-metric",
    term: "Certified metric",
    kind: "exasol",
    plain: "A metric whose definition has been checked and approved, so a number like 'approval rate' means the same thing everywhere.",
    inExasol: "Metrics in CREDORA_SEM.PORTFOLIO are marked PUBLIC CERTIFIED, for example approval_rate = approved_companies / companies_analysed. The model is GOVERNED and published with SEMANTIC_ADMIN.PUBLISH_MODEL. Ask Credora answers from these metrics first.",
    objects: ["CREDORA_SEM.PORTFOLIO"],
    code: {
      lang: "sql",
      file: "exasol/semantic/12_credora_model.sql",
      snippet: `METRIC approval_rate AS approved_companies / NULLIF(companies_analysed, 0) ON ENTITY decision RETURNS DOUBLE
  FORMAT ''percentage'' DISPLAY ''Approval rate'' COMMENT ''Pre-approved companies / companies analysed, 0..1''
  SYNONYMS (''approval ratio'', ''hit rate'') RATIO PUBLIC CERTIFIED,`,
    },
    related: ["semantic-view"],
  },
  "sql-preprocessor": {
    id: "sql-preprocessor",
    term: "SQL preprocessor (preprocessor-framework)",
    kind: "exasol",
    plain: "A script that can rewrite each SQL statement before Exasol runs it. Exasol has one system-wide slot for it.",
    inExasol: "PREPROC_RT.MASTER from exasol-labs/preprocessor-framework v0.9.1 owns the slot (ALTER SYSTEM SET SQL_PREPROCESSOR_SCRIPT) and runs per user the modules its rules name. The module PREPROC_RT.SEMANTIC_VIEWS_V1 turns semantic SQL into plain SQL for R_ADMIN, R_DATASCI, R_LOANOPS, R_RM and R_MCP. CREDORA_SVC has no rule.",
    objects: ["PREPROC_RT.MASTER", "PREPROC_RT.SEMANTIC_VIEWS_V1", "PREPROC.CONFIG"],
    code: {
      lang: "sql",
      file: "exasol/extensions/10_semantic_views_module.sql",
      snippet: `EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_MCP', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_ADMIN', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_DATASCI', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_LOANOPS', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_RM', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/sql_preprocessor.htm",
    related: ["semantic-view", "role"],
  },
  "role": {
    id: "role",
    term: "Role",
    kind: "exasol",
    plain: "A named bundle of permissions. Give a role to a user, and the user gets all its permissions.",
    inExasol: "There are six roles, R_SVC (runs analysis, training and purge), R_ADMIN, R_DATASCI, R_LOANOPS, R_RM and R_MCP. The deploy tool creates them (deploy/exasol_setup.py create_roles), and 07_security.sql grants them their rights.",
    objects: ["R_SVC", "R_ADMIN", "R_DATASCI", "R_LOANOPS", "R_RM", "R_MCP"],
    code: {
      lang: "python",
      file: "deploy/exasol_setup.py",
      snippet: `def create_roles(ex: Exasol) -> None:
    with ex.connect() as c:
        existing = {r[0] for r in c.execute("SELECT ROLE_NAME FROM EXA_DBA_ROLES").fetchall()}
        for role in {r for r, _ in ROLE_USERS.values()} - existing:
            c.execute(f"CREATE ROLE {role}")`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/create_role.htm",
    related: ["user", "grant", "schema-grant"],
  },
  "user": {
    id: "user",
    term: "Exasol user",
    kind: "exasol",
    plain: "A database login. In Credora each app role has its own Exasol user, so the database itself knows who is reading.",
    inExasol: "CREDORA_ADMIN, CREDORA_DATASCI, CREDORA_LOANOPS and CREDORA_RM each hold the matching role. CREDORA_SVC runs jobs and CREDORA_MCP is the Ask Credora fallback. Passwords come from the deployment's runtime secret in AWS Secrets Manager.",
    objects: ["CREDORA_ADMIN", "CREDORA_DATASCI", "CREDORA_LOANOPS", "CREDORA_RM", "CREDORA_SVC", "CREDORA_MCP"],
    code: {
      lang: "python",
      file: "deploy/exasol_setup.py",
      snippet: `def create_users(ex: Exasol, secret: dict) -> None:
    """One Exasol user per app role; passwords come from the deployment's runtime secret."""
    with ex.connect() as c:
        existing = {r[0] for r in c.execute("SELECT USER_NAME FROM EXA_DBA_USERS").fetchall()}
        for user, (role, key) in ROLE_USERS.items():
            verb = "ALTER" if user in existing else "CREATE"
            c.execute(f'{verb} USER {user} IDENTIFIED BY "{secret[key]}"')
            c.execute(f"GRANT {role} TO {user}")`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/create_user.htm",
    related: ["role", "credora-svc", "sessions", "secrets-manager"],
  },
  "grant": {
    id: "grant",
    term: "GRANT",
    kind: "exasol",
    plain: "The SQL statement that gives a permission to a role or user, for example the right to read a table or use a connection.",
    inExasol: "07_security.sql and 13_rm_row_security.sql grant every right in Credora. A query outside a role's grants fails in Exasol with 'insufficient privileges', and the web app shows 403.",
    objects: ["R_SVC", "MOCK_CIBIL", "BUCKETFS_MODELS"],
    code: {
      lang: "sql",
      file: "exasol/sql/07_security.sql",
      snippet: `GRANT ACCESS ON CONNECTION MOCK_CIBIL TO R_SVC;
GRANT ACCESS ON CONNECTION MOCK_GSTN TO R_SVC;
GRANT ACCESS ON CONNECTION MOCK_AA TO R_SVC;
GRANT ACCESS ON CONNECTION BUCKETFS_MODELS TO R_SVC;`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/grant.htm",
    related: ["role", "schema-grant", "connection-object"],
  },
  "schema-grant": {
    id: "schema-grant",
    term: "Schema-level grant",
    kind: "exasol",
    plain: "One grant that covers every table and view in a schema, now and later.",
    inExasol: "R_ADMIN and R_DATASCI read all of CREDORA and CREDORA_STAGE. R_LOANOPS reads CREDORA but not CREDORA_STAGE, so loan operations never sees raw CIBIL, GST or AA replies. R_SVC gets SELECT, INSERT, UPDATE, DELETE on both schemas.",
    objects: ["CREDORA", "CREDORA_STAGE", "VS_CBS", "VS_CIF", "VS_LOS"],
    code: {
      lang: "sql",
      file: "exasol/sql/07_security.sql",
      snippet: `GRANT SELECT ON SCHEMA CREDORA TO R_ADMIN, R_DATASCI;
GRANT SELECT ON SCHEMA CREDORA_STAGE TO R_ADMIN, R_DATASCI;`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/grant.htm",
    related: ["grant", "credora-stage"],
  },
  "owner-rights-view": {
    id: "owner-rights-view",
    term: "View with owner's rights",
    kind: "exasol",
    plain: "An Exasol view reads its tables with the rights of the view's owner. A user only needs the right to read the view, not the tables under it.",
    inExasol: "R_RM is granted the V_RM_* views but has no grant on DECISIONS, SCORES, FEATURES or APPLICATIONS. CREDORA.V_SESSION_SCOPE reads EXA_DBA_ROLE_PRIVS with its owner's rights to tell whether the logged-in user holds R_RM.",
    objects: ["CREDORA.V_SESSION_SCOPE", "CREDORA.V_RM_DECISIONS", "CREDORA.V_LATEST_DECISION"],
    code: {
      lang: "sql",
      file: "exasol/sql/13_rm_row_security.sql",
      snippet: `CREATE OR REPLACE VIEW CREDORA.V_SESSION_SCOPE AS
SELECT CURRENT_USER EXA_USER,
       CASE WHEN EXISTS (SELECT 1 FROM EXA_DBA_ROLE_PRIVS p
                         WHERE p.GRANTEE = CURRENT_USER AND p.GRANTED_ROLE = 'R_RM') THEN TRUE ELSE FALSE END IS_RM
FROM DUAL;`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/create_view.htm",
    related: ["row-level-security", "current-user"],
  },
  "row-level-security": {
    id: "row-level-security",
    term: "Row-level security view",
    kind: "exasol",
    plain: "A view that returns only the rows the logged-in person may see, decided by the database rather than the app.",
    inExasol: "Each V_RM_* view joins CREDORA.RM_ASSIGNMENT on EXA_USER = CURRENT_USER and CREDORA.RUN_PUBLISH, so a relationship manager gets only assigned companies from published runs. The V_LATEST_* views behind the semantic layer apply the same filter through V_SESSION_SCOPE.",
    objects: ["CREDORA.V_RM_DECISIONS", "CREDORA.V_RM_COMPANY", "CREDORA.V_RM_FEATURES", "CREDORA.V_RM_SCORES", "CREDORA.V_RM_ASSIGNMENT", "CREDORA.V_RM_LOAN_STATUS"],
    code: {
      lang: "sql",
      file: "exasol/sql/13_rm_row_security.sql",
      snippet: `CREATE OR REPLACE VIEW CREDORA.V_RM_DECISIONS AS
SELECT d.*
FROM CREDORA.DECISIONS d
JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = d.CIF_ID AND a.EXA_USER = CURRENT_USER
JOIN CREDORA.RUN_PUBLISH p ON p.RUN_ID = d.RUN_ID;`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/create_view.htm",
    related: ["rm-assignment", "current-user", "owner-rights-view", "run-publish"],
  },
  "current-user": {
    id: "current-user",
    term: "CURRENT_USER",
    kind: "exasol",
    plain: "A SQL function that returns the name of the database user running the query.",
    inExasol: "The V_RM_* views compare RM_ASSIGNMENT.EXA_USER with CURRENT_USER, so the same view returns a different book for each RM login. In the demo, CREDORA_RM acts for RM001.",
    objects: ["CREDORA.V_RM_ASSIGNMENT", "CREDORA.RM_ASSIGNMENT"],
    code: {
      lang: "sql",
      file: "exasol/sql/13_rm_row_security.sql",
      snippet: `CREATE OR REPLACE VIEW CREDORA.V_RM_ASSIGNMENT AS
SELECT a.CIF_ID, a.RM_ID, a.ASSIGNED_BY, a.ASSIGNED_AT
FROM CREDORA.RM_ASSIGNMENT a
WHERE a.EXA_USER = CURRENT_USER;`,
    },
    docs: "https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/current_user.htm",
    related: ["row-level-security", "user"],
  },
  "select-any-dictionary": {
    id: "select-any-dictionary",
    term: "SELECT ANY DICTIONARY",
    kind: "exasol",
    plain: "A system privilege to read every system table, including those about other users and sessions.",
    inExasol: "Only R_ADMIN holds it in Credora. Other roles see the EXA_ALL_* tables, which list only objects they may use.",
    objects: ["R_ADMIN"],
    code: {
      lang: "sql",
      file: "exasol/sql/07_security.sql",
      snippet: `GRANT SELECT ANY DICTIONARY TO R_ADMIN;`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/privileges.htm",
    related: ["system-tables", "role"],
  },
  "system-tables": {
    id: "system-tables",
    term: "System tables (EXA_ALL_*, EXA_DBA_*)",
    kind: "exasol",
    plain: "Read-only tables in which Exasol describes itself, such as users, roles, connections, columns, parameters and sessions.",
    inExasol: "The backend checks EXA_ALL_CONNECTIONS for AI_LLM and EXA_ALL_COLUMNS for view columns. The deploy tool reads EXA_DBA_ROLES, EXA_DBA_USERS and EXA_PARAMETERS. V_SESSION_SCOPE reads EXA_DBA_ROLE_PRIVS.",
    objects: ["EXA_ALL_CONNECTIONS", "EXA_ALL_COLUMNS", "EXA_DBA_ROLE_PRIVS", "EXA_PARAMETERS"],
    code: {
      lang: "python",
      file: "backend/app/memo.py",
      snippet: `val = bool(exa.scalar(exa.SVC, "SELECT COUNT(*) FROM EXA_ALL_CONNECTIONS WHERE CONNECTION_NAME = 'AI_LLM'"))`,
    },
    docs: "https://docs.exasol.com/db/latest/sql_references/system_tables.htm",
    related: ["select-any-dictionary"],
  },
  "sessions": {
    id: "sessions",
    term: "Sessions",
    kind: "exasol",
    plain: "A session is one open connection to Exasol, with its own settings and transaction.",
    inExasol: "The backend keeps a small pool of pyexasol sessions per Exasol user (client name credora-backend). Long jobs such as RUN_ANALYSIS get their own CREDORA_SVC session. Each Ask Credora question starts an MCP server that opens its own session as the role's user.",
    objects: ["CREDORA_SVC", "CREDORA_RM", "EXA_ALL_SESSIONS"],
    code: {
      lang: "python",
      file: "backend/app/exa.py",
      snippet: `def _connect(user: str) -> pyexasol.ExaConnection:
    try:
        return pyexasol.connect(
            dsn=f"{settings.exasol_host}:{settings.exasol_port}",
            user=user,
            password=settings.exa_passwords.get(user, ""),
            encryption=True,
            websocket_sslopt={"cert_reqs": ssl.CERT_NONE},  # Exasol's certificate is self-signed
            compression=True,
            fetch_mapper=pyexasol.exasol_mapper,
            connection_timeout=10,
            socket_timeout=300,`,
    },
    docs: "https://docs.exasol.com/db/latest/sql_references/system_tables/metadata/exa_all_sessions.htm",
    related: ["user", "commit-per-step", "exasol-mcp-server"],
  },
  "model-registry": {
    id: "model-registry",
    term: "MODEL_REGISTRY",
    kind: "exasol",
    plain: "The table that lists every trained risk model, with when it was trained, how good it is and where the file is.",
    inExasol: "CREDORA.TRAIN_MODEL inserts one row per model with ALGORITHM, AUC, GINI, N_TRAIN, DEFAULT_RATE, FEATURE_IMPORTANCE and MODEL_PATH in BucketFS. IS_ACTIVE marks the one model that decides.",
    objects: ["CREDORA.MODEL_REGISTRY"],
    code: {
      lang: "sql",
      file: "exasol/sql/01_schemas.sql",
      snippet: `CREATE TABLE IF NOT EXISTS CREDORA.MODEL_REGISTRY (
  MODEL_VERSION VARCHAR(20), TRAINED_AT TIMESTAMP, ALGORITHM VARCHAR(80), AUC DECIMAL(6,4), GINI DECIMAL(6,4),
  N_TRAIN DECIMAL(10), DEFAULT_RATE DECIMAL(6,4), FEATURE_IMPORTANCE VARCHAR(20000), MODEL_PATH VARCHAR(200),
  IS_ACTIVE BOOLEAN
);`,
    },
    related: ["model-activation", "pickle-model", "challenger-model"],
  },
  "pickle-model": {
    id: "pickle-model",
    term: "Pickled model in BucketFS",
    kind: "exasol",
    plain: "A trained model saved as a file (Python pickle), so it can be loaded again later to score new companies.",
    inExasol: "TRAIN_PD and TRAIN_SCORECARD save models/pd_<version>.pkl to BucketFS. PD_SCORE opens /buckets/bfsdefault/default/models/pd_<version>.pkl, waits up to 60 s for it to reach the node, and caches it per UDF instance.",
    objects: ["CREDORA.PD_SCORE", "BUCKETFS_MODELS"],
    code: {
      lang: "python",
      file: "exasol/udf/05_ml_udfs.sql",
      snippet: `def load(path):
    if path not in _cache:
        for _ in range(60):  # a freshly trained model can take a few seconds to sync to every node
            if os.path.exists(path):
                break
            time.sleep(1)
        with open(path, "rb") as f:
            _cache[path] = pickle.load(f)`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/bucketfs/bucketfs.htm",
    related: ["bucketfs", "model-registry"],
  },
  "model-activation": {
    id: "model-activation",
    term: "Model activation (IS_ACTIVE)",
    kind: "exasol",
    plain: "Choosing which trained model makes the real decisions. Only one model is active at a time.",
    inExasol: "One UPDATE sets IS_ACTIVE = (MODEL_VERSION = :v) in CREDORA.MODEL_REGISTRY, run as CREDORA_SVC after the admin approves. Training keeps the previously active model active in the same transaction. Step 8 of RUN_ANALYSIS reads the active model's MODEL_PATH for scoring.",
    objects: ["CREDORA.MODEL_REGISTRY"],
    code: {
      lang: "python",
      file: "backend/app/activation.py",
      snippet: `def activate(version: str) -> None:
    # The role users are read-only in Exasol; the switch is made by the service account.
    exa.query(exa.SVC, "UPDATE CREDORA.MODEL_REGISTRY SET IS_ACTIVE = (MODEL_VERSION = {v})", {"v": version})`,
    },
    related: ["model-registry", "model-activation-approval", "challenger-model"],
  },
  "purge-proof": {
    id: "purge-proof",
    term: "Purge with SHA-256 proof",
    kind: "exasol",
    plain: "Raw 3rd party data, fetched on demand via API, is deleted on time, and a fingerprint of what was deleted is kept, so an auditor can check it without the data.",
    inExasol: "CREDORA.PURGE_EXPIRED finds CREDORA_STAGE rows past PURGE_AT, writes the row count and HASH_SHA256 of their key columns to CREDORA.PURGE_LOG, then deletes them. The Exasol Scheduler runs it as CREDORA_SVC every 15 minutes (task credora_purge_expired in SCHED.SCHED_TASKS), inside Exasol.",
    objects: ["CREDORA.PURGE_EXPIRED", "CREDORA.PURGE_LOG", "CREDORA_STAGE"],
    code: {
      lang: "lua",
      file: "exasol/lua/08_purge.sql",
      snippet: `local runs = query([[SELECT RUN_ID, COUNT(*) N,
                            HASH_SHA256(LISTAGG(]] .. x.key .. [[, '|') WITHIN GROUP (ORDER BY ]] .. x.key .. [[)) H
                     FROM CREDORA_STAGE.]] .. x.t .. [[ WHERE PURGE_AT <= SYSTIMESTAMP GROUP BY RUN_ID]])
for i = 1, #runs do
  query([[INSERT INTO CREDORA.PURGE_LOG VALUES (SYSTIMESTAMP, :t, :r, :n, :h)]],
        {t = 'CREDORA_STAGE.' .. x.t, r = runs[i].RUN_ID, n = runs[i].N, h = runs[i].H})
  query('DELETE FROM CREDORA_STAGE.' .. x.t .. ' WHERE RUN_ID = :r AND PURGE_AT <= SYSTIMESTAMP', {r = runs[i].RUN_ID})
  out[#out + 1] = {x.t, runs[i].RUN_ID, runs[i].N}`,
    },
    docs: "https://docs.exasol.com/db/latest/sql_references/functions/alphabeticallistfunctions/hash_sha256.htm",
    related: ["credora-stage", "consent"],
  },
  "credora-stage": {
    id: "credora-stage",
    term: "CREDORA_STAGE",
    kind: "exasol",
    plain: "The schema that holds raw replies from the 3rd party APIs (CIBIL, GSTN, Account Aggregator), each row with a delete-by time.",
    inExasol: "Steps 3 to 6 of RUN_ANALYSIS fill CIBIL_CONSUMER, CIBIL_COMMERCIAL, GST_FILING and AA_ACCOUNT. PURGE_AT is 7 days for CIBIL and GST and the consent expiry for AA. R_LOANOPS, R_RM and R_MCP have no grant on it.",
    objects: ["CREDORA_STAGE.CIBIL_CONSUMER", "CREDORA_STAGE.CIBIL_COMMERCIAL", "CREDORA_STAGE.GST_FILING", "CREDORA_STAGE.AA_ACCOUNT"],
    code: {
      lang: "sql",
      file: "exasol/sql/01_schemas.sql",
      snippet: `CREATE TABLE IF NOT EXISTS CREDORA_STAGE.AA_ACCOUNT (
  RUN_ID VARCHAR(20), PAN CHAR(10), CONSENT_ID VARCHAR(36), CONSENT_EXPIRES TIMESTAMP, AA_ACCOUNT_ID VARCHAR(16),
  FIP VARCHAR(40), ACCT_TYPE VARCHAR(10), MASKED_NO VARCHAR(20), OPENED_ON DATE, CURRENT_BALANCE DECIMAL(18,2),
  TXN_COUNT DECIMAL(8), CREDITS_12M DECIMAL(18,2), DEBITS_12M DECIMAL(18,2), FETCHED_AT TIMESTAMP, PURGE_AT TIMESTAMP
);`,
    },
    related: ["purge-proof", "schema-grant"],
  },
  "credora-schema": {
    id: "credora-schema",
    term: "CREDORA schema",
    kind: "exasol",
    plain: "The schema that holds Credora's results, such as credit needs on file, features, scores, decisions, models, run log and policy.",
    inExasol: "The main tables are APPLICATIONS, FEATURES, SCORES, ANOMALY, DECISIONS, CHALLENGER_SCORES, MODEL_REGISTRY, RUN_LOG, CONFIG, PURGE_LOG, MEMOS, RM_ASSIGNMENT, RUN_PUBLISH and LOAN_STATUS_LOG. Every result row carries RUN_ID, so runs are kept side by side.",
    objects: ["CREDORA.DECISIONS", "CREDORA.FEATURES", "CREDORA.SCORES", "CREDORA.RUN_LOG"],
    related: ["credora-stage", "run-log"],
  },
  "policy-config": {
    id: "policy-config",
    term: "CREDORA.CONFIG (policy knobs)",
    kind: "exasol",
    plain: "The bank's lending policy as numbers, covering base rate, cost of funds, loss rate, capital, hurdle and limits.",
    inExasol: "The decision SQL reads every value from CREDORA.CONFIG, so a policy change is one UPDATE, with no code change. What-if overrides these values inside one query. An approved policy proposal writes them as CREDORA_SVC.",
    objects: ["CREDORA.CONFIG"],
    code: {
      lang: "sql",
      file: "exasol/sql/01_schemas.sql",
      snippet: `CREATE TABLE IF NOT EXISTS CREDORA.CONFIG (
  CONFIG_KEY   VARCHAR(40) PRIMARY KEY,
  CONFIG_VALUE DECIMAL(12,4) NOT NULL,
  DESCRIPTION  VARCHAR(200)
);`,
    },
    related: ["what-if", "policy-proposal", "hurdle-rate", "eblr"],
  },
  "credora-svc": {
    id: "credora-svc",
    term: "CREDORA_SVC",
    kind: "exasol",
    plain: "The service login the web app uses for background jobs. People never sign in as it.",
    inExasol: "CREDORA_SVC (role R_SVC) runs RUN_ANALYSIS, TRAIN_MODEL, PURGE_EXPIRED, credit memos and the writes to CONFIG, MODEL_REGISTRY, RM_ASSIGNMENT, RUN_PUBLISH and LOAN_STATUS_LOG. All reads for a signed-in person go through that role's own user instead.",
    objects: ["CREDORA_SVC", "R_SVC"],
    code: {
      lang: "python",
      file: "backend/app/exa.py",
      snippet: `ROLE_USER = {
    "admin": "CREDORA_ADMIN",
    "datasci": "CREDORA_DATASCI",
    "loanops": "CREDORA_LOANOPS",
    "rm": "CREDORA_RM",
}
SVC = "CREDORA_SVC"`,
    },
    related: ["user", "role", "sessions"],
  },
  "omp-num-threads": {
    id: "omp-num-threads",
    term: "OMP_NUM_THREADS",
    kind: "exasol",
    plain: "A setting that tells numeric libraries how many CPU threads to use.",
    inExasol: "PD_SCORE sets it to 1 because Exasol already runs one UDF instance per core (4 instances on the r6i.xlarge). TRAIN_PD, TRAIN_SCORECARD and ANOMALY_FLAG run as one instance and set it to 4.",
    objects: ["CREDORA.PD_SCORE", "CREDORA.TRAIN_PD", "CREDORA.ANOMALY_FLAG"],
    code: {
      lang: "python",
      file: "exasol/udf/05_ml_udfs.sql",
      snippet: `os.environ["OMP_NUM_THREADS"] = "1"  # one UDF instance per core already; avoid thread oversubscription`,
    },
    related: ["python-udf", "scalar-vs-set-udf"],
  },
  "exasol-personal-aws": {
    id: "exasol-personal-aws",
    term: "Exasol Personal on AWS",
    kind: "exasol",
    plain: "The free single-node edition of Exasol, installed on an AWS server by Exasol's official launcher.",
    inExasol: "deploy/credora.py runs the exasol launcher (exasol init aws ubuntu) on an r6i.xlarge EC2 instance and limits its ports (8563, 8443, 2581, 22 and others) to the admin's IP. Every Exasol object is then created from the repo by deploy/exasol_setup.py and the exasol/ SQL files.",
    objects: ["CREDORA", "CREDORA_STAGE", "VS_CBS"],
    code: {
      lang: "python",
      file: "deploy/credora.py",
      snippet: `sh(["exasol", "init", "aws", "ubuntu", "--deployment-dir", str(self.exasol_dir), "--auto-approve",
    "--instance-type", self.cfg.get("EXASOL_INSTANCE", "r6i.xlarge")], env=self.aws_env())`,
    },
    related: ["ec2-app-host", "bucketfs"],
  },
  "exasol-mcp-server": {
    id: "exasol-mcp-server",
    term: "Exasol MCP server",
    kind: "exasol",
    plain: "Exasol's official server that lets an AI model look up tables and run read-only SQL through standard tool calls (MCP).",
    inExasol: "For each Ask Credora question the backend starts exasol-mcp-server 2.3.0 over stdio, logged in as the signed-in person's Exasol user (exasol_login()). CREDORA_MCP is only the fallback. Write queries, BucketFS writes and preprocessor tools are switched off.",
    objects: ["CREDORA_ADMIN", "CREDORA_RM", "CREDORA_MCP", "R_MCP"],
    code: {
      lang: "python",
      file: "backend/app/assistant.py",
      snippet: `MCP_SERVER_PACKAGE = "exasol-mcp-server@2.3.0"
MCP_USER = "CREDORA_MCP"
# Read-only: SELECT and metadata only; no writes, no BucketFS, no profiling.
MCP_SETTINGS = {
    "enable_read_query": True,
    "enable_summarize_table": True,
    "enable_query_profiling": False,
    "enable_write_query": False,
    "enable_write_bucketfs": False,
    # The database applies the semantic layer's preprocessor; the assistant must not replace it.
    "enable_preprocessor_tools": False,`,
    },
    related: ["ask-credora", "mcp-tool-call", "topic-gate", "user"],
  },
  "run-log": {
    id: "run-log",
    term: "RUN_LOG",
    kind: "exasol",
    plain: "The diary of an analysis run, with one line per step and its rows produced and time taken.",
    inExasol: "RUN_ANALYSIS writes CREDORA.RUN_LOG (RUN_ID, STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS, DETAIL) after every step. The run screens and the Exasol report read it.",
    objects: ["CREDORA.RUN_LOG"],
    code: {
      lang: "sql",
      file: "exasol/sql/01_schemas.sql",
      snippet: `CREATE TABLE IF NOT EXISTS CREDORA.RUN_LOG (
  RUN_ID       VARCHAR(20),
  STEP_NO      DECIMAL(3),
  STEP_NAME    VARCHAR(100),
  STATUS       VARCHAR(10),
  ROWS_OUT     DECIMAL(18),
  MS           DECIMAL(18),
  DETAIL       VARCHAR(2000),
  LOGGED_AT    TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
    },
    related: ["run-analysis", "commit-per-step"],
  },
  "run-analysis": {
    id: "run-analysis",
    term: "CREDORA.RUN_ANALYSIS",
    kind: "exasol",
    plain: "The one database call that does the whole daily analysis, from reading the bank's data to ranking the best offers.",
    inExasol: "A Lua script with 13 logged steps. They refresh virtual schemas, read credit needs on file, make four 3rd party API fetches and cover features, risk model, PD scoring, anomaly flag, decide, PREFERRING rank and challenger shadow scoring. The backend runs EXECUTE SCRIPT CREDORA.RUN_ANALYSIS('<run>') as CREDORA_SVC.",
    objects: ["CREDORA.RUN_ANALYSIS", "CREDORA.RUN_LOG", "CREDORA.DECISIONS"],
    code: {
      lang: "python",
      file: "backend/app/jobs.py",
      snippet: `st = conn.execute("EXECUTE SCRIPT CREDORA.RUN_ANALYSIS({r})", {"r": run_id})`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/execute_script.htm",
    related: ["lua-script", "run-log", "commit-per-step"],
  },
  "masked-view": {
    id: "masked-view",
    term: "Masked company view",
    kind: "exasol",
    plain: "A view that shows a company's details with PAN and GSTIN hidden except for their last characters.",
    inExasol: "CREDORA.V_COMPANY_MASKED joins APPLICATIONS and FEATURES and masks PAN and GSTIN in SQL. R_MCP reads it, and V_LATEST_COMPANY (behind the semantic layer) is built on it.",
    objects: ["CREDORA.V_COMPANY_MASKED", "CREDORA.V_LATEST_COMPANY"],
    code: {
      lang: "sql",
      file: "exasol/sql/07_security.sql",
      snippet: `CREATE OR REPLACE VIEW CREDORA.V_COMPANY_MASKED AS
SELECT a.RUN_ID, a.APP_ID, a.CIF_ID, a.LEGAL_NAME, a.CONSTITUTION,
       'XXXXXX' || SUBSTR(a.PAN, 7, 4) PAN_MASKED, SUBSTR(a.GSTIN, 1, 2) || 'XXXXXXXXX' || SUBSTR(a.GSTIN, 12, 4) GSTIN_MASKED,`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/create_view.htm",
    related: ["owner-rights-view", "row-level-security"],
  },
  "latest-run-views": {
    id: "latest-run-views",
    term: "Latest-run views (V_LATEST_*)",
    kind: "exasol",
    plain: "Views that always show the newest finished, published analysis run, one row per company.",
    inExasol: "V_LATEST_RUN picks the newest run in RUN_PUBLISH that finished every step without a failure. V_LATEST_COMPANY, _DECISION, _SCORE and _FEATURE join it, filter rows for RMs, and feed CREDORA_SEM.PORTFOLIO.",
    objects: ["CREDORA.V_LATEST_RUN", "CREDORA.V_LATEST_DECISION", "CREDORA.V_LATEST_COMPANY"],
    code: {
      lang: "sql",
      file: "exasol/semantic/11_latest_run_views.sql",
      snippet: `CREATE OR REPLACE VIEW CREDORA.V_LATEST_RUN AS
SELECT RUN_ID, FINISHED_AT FROM (
  SELECT l.RUN_ID, MAX(l.LOGGED_AT) FINISHED_AT
  FROM CREDORA.RUN_LOG l
  WHERE l.RUN_ID IN (SELECT RUN_ID FROM CREDORA.RUN_PUBLISH)
  GROUP BY l.RUN_ID
  HAVING SUM(CASE WHEN STATUS = 'FAILED' THEN 1 ELSE 0 END) = 0
     AND (MAX(STEP_NO) >= 13
          OR MAX(CASE WHEN STEP_NO = 11 AND STEP_NAME = 'Rank with PREFERRING skyline' THEN 1 ELSE 0 END) = 1)
) ORDER BY FINISHED_AT DESC, RUN_ID DESC LIMIT 1;`,
    },
    related: ["semantic-view", "run-publish", "row-level-security"],
  },
  "lua-import": {
    id: "lua-import",
    term: "Lua script library (import)",
    kind: "exasol",
    plain: "One script can load another as a library, so shared logic lives in one place.",
    inExasol: "CREDORA.DECISION_LOGIC holds the decision SQL once. RUN_ANALYSIS runs it on CREDORA.SCORES and SCORE_CHALLENGER runs the same SQL on CREDORA.CHALLENGER_SCORES. Only the scores table name is swapped.",
    objects: ["CREDORA.DECISION_LOGIC", "CREDORA.RUN_ANALYSIS", "CREDORA.SCORE_CHALLENGER"],
    code: {
      lang: "lua",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `local i, j = string.find(sql, 'CREDORA.SCORES', 1, true)
return string.sub(sql, 1, i - 1) .. scores .. string.sub(sql, j + 1)`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/scripting/general_script_language.htm",
    related: ["lua-script", "challenger-model"],
  },
  "challenger-model": {
    id: "challenger-model",
    term: "Challenger scorecard model",
    kind: "exasol",
    plain: "A second, simpler risk model (logistic regression scorecard) trained next to the main one. It only shadows. It shows what it would decide, but decides nothing.",
    inExasol: "TRAIN_MODEL trains <version>-lr with the Python UDF CREDORA.TRAIN_SCORECARD on the same past loans and hold-out. Step 13 runs CREDORA.SCORE_CHALLENGER, which scores the run with PD_SCORE and writes PD, grade and the decision it would give to CREDORA.CHALLENGER_SCORES.",
    objects: ["CREDORA.TRAIN_SCORECARD", "CREDORA.SCORE_CHALLENGER", "CREDORA.CHALLENGER_SCORES"],
    code: {
      lang: "lua",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `local ch = query([[
  SELECT MODEL_VERSION, MODEL_PATH FROM CREDORA.MODEL_REGISTRY
  WHERE NOT IS_ACTIVE AND ALGORITHM <> (SELECT MAX(ALGORITHM) FROM CREDORA.MODEL_REGISTRY WHERE IS_ACTIVE)
  ORDER BY TRAINED_AT DESC LIMIT 1]])`,
    },
    related: ["risk-model", "model-activation", "lua-import"],
  },
  "anomaly-flag": {
    id: "anomaly-flag",
    term: "Isolation Forest anomaly flag",
    kind: "exasol",
    plain: "A model that spots companies whose figures look unlike everyone else's, for example GST sales far above bank credits. Flagged companies go to a person and are never declined for it.",
    inExasol: "Step 10 of RUN_ANALYSIS calls the Python UDF CREDORA.ANOMALY_FLAG as one instance over the run's features and writes CREDORA.ANOMALY. CONFIG ANOMALY_CONTAMINATION_PCT (3%) sets the share flagged. The decision step turns a flag into REFER with the reason 'Anomaly: ...'.",
    objects: ["CREDORA.ANOMALY_FLAG", "CREDORA.ANOMALY", "CREDORA.CONFIG"],
    code: {
      lang: "lua",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `step(10, 'Flag anomalies (Isolation Forest UDF)', function()
  return rows(query([[
    INSERT INTO CREDORA.ANOMALY
    SELECT :r, app_id, score, is_anomaly, top_reasons
    FROM (SELECT CREDORA.ANOMALY_FLAG(f.APP_ID, c.CONFIG_VALUE, f.GST_TURNOVER_12M, f.BANK_CREDITS_12M,
                                      f.AVG_BALANCE_12M, f.INFLOW_VOLATILITY, f.PARTNER_OTHER_BANK_BAL)
          FROM CREDORA.FEATURES f
          LEFT JOIN CREDORA.CONFIG c ON c.CONFIG_KEY = 'ANOMALY_CONTAMINATION_PCT'
          WHERE f.RUN_ID = :r)]], p))
end)`,
    },
    related: ["approve-refer-decline", "gst-bank-gap"],
  },
  "run-publish": {
    id: "run-publish",
    term: "Run publish",
    kind: "exasol",
    plain: "A finished analysis run is a draft until the data scientist publishes it. Loan operations and RMs then work from it.",
    inExasol: "Publishing inserts a row into CREDORA.RUN_PUBLISH as CREDORA_SVC. V_LATEST_RUN and every V_RM_* view read only published runs, so the semantic layer and the RM book switch to the new run at once.",
    objects: ["CREDORA.RUN_PUBLISH", "CREDORA.V_LATEST_RUN"],
    code: {
      lang: "sql",
      file: "exasol/sql/13_rm_row_security.sql",
      snippet: `CREATE TABLE IF NOT EXISTS CREDORA.RUN_PUBLISH (
  RUN_ID       VARCHAR(20) NOT NULL,
  PUBLISHED_BY VARCHAR(40) NOT NULL,
  PUBLISHED_AT TIMESTAMP NOT NULL,
  NOTE         VARCHAR(400)
);`,
    },
    related: ["latest-run-views", "row-level-security"],
  },
  "rm-assignment": {
    id: "rm-assignment",
    term: "RM assignment",
    kind: "exasol",
    plain: "Loan operations decides which relationship manager works which company.",
    inExasol: "CREDORA.RM_ASSIGNMENT has one row per company with RM_ID and EXA_USER, the Exasol user that logs in for that manager. Assigning again moves the company. The web app MERGEs it as CREDORA_SVC, and the V_RM_* views filter on it with CURRENT_USER.",
    objects: ["CREDORA.RM_ASSIGNMENT", "CREDORA.V_RM_ASSIGNMENT"],
    code: {
      lang: "sql",
      file: "exasol/sql/13_rm_row_security.sql",
      snippet: `CREATE TABLE IF NOT EXISTS CREDORA.RM_ASSIGNMENT (
  CIF_ID      VARCHAR(8) NOT NULL,
  RM_ID       VARCHAR(6) NOT NULL,     -- relationship manager in the customer master (cif.rm)
  EXA_USER    VARCHAR(128) NOT NULL,   -- the Exasol user that logs in for this manager
  ASSIGNED_BY VARCHAR(20) NOT NULL,    -- web app user of loan operations
  ASSIGNED_AT TIMESTAMP NOT NULL
);`,
    },
    related: ["row-level-security", "current-user", "rm"],
  },
  "claude": {
    id: "claude",
    term: "Claude",
    kind: "ai",
    plain: "Anthropic's AI model. In Credora it answers plain-English questions and writes short credit memos.",
    inExasol: "Claude never connects to Exasol directly. It reads data only through Exasol MCP server tool calls as the person's Exasol user, or receives the facts inside the CREDIT_MEMO UDF.",
    objects: ["AI_LLM", "CREDORA.CREDIT_MEMO"],
    related: ["credit-memo-udf", "ask-credora", "mcp-tool-call"],
  },
  "credit-memo-udf": {
    id: "credit-memo-udf",
    term: "Credit memo UDF (CONNECTION AI_LLM)",
    kind: "ai",
    plain: "A short memo for the relationship manager in four lines, Decision, Why, Watch and Negotiate. Written by Claude from the company's numbers only.",
    inExasol: "CREDORA.CREDIT_MEMO is a Python SCALAR UDF that calls the Claude API with the key held in CONNECTION AI_LLM (only R_SVC has ACCESS). The backend runs it as CREDORA_SVC and stores the result in CREDORA.MEMOS with engine exasol-udf. On Bedrock the backend calls the model itself (engine backend).",
    objects: ["CREDORA.CREDIT_MEMO", "AI_LLM", "CREDORA.MEMOS"],
    code: {
      lang: "python",
      file: "exasol/udf/09_ai_udf.sql",
      snippet: `def run(ctx):
    conn = exa.get_connection(ctx.conn_name)
    r = requests.post(
        f"{conn.address}/v1/messages",
        headers={"x-api-key": conn.password, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": ctx.model, "max_tokens": 400, "system": SYSTEM,
              "messages": [{"role": "user", "content": ctx.facts}]},
        timeout=60,`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/udf_scripts/python3.htm",
    related: ["claude", "connection-object", "scalar-vs-set-udf"],
  },
  "mcp-tool-call": {
    id: "mcp-tool-call",
    term: "MCP tool call",
    kind: "ai",
    plain: "When the AI needs data, it calls a named tool (for example 'run this query') and reads the result before answering.",
    inExasol: "Claude calls tools such as execute_exasol_query and describe_exasol_tables_and_views on the Exasol MCP server, at most 8 per question. Every call and its SQL is returned with the answer and shown on screen.",
    objects: ["CREDORA_SEM.PORTFOLIO", "CREDORA.DECISIONS"],
    code: {
      lang: "python",
      file: "backend/app/assistant.py",
      snippet: `calls += 1
try:
    r = await asyncio.wait_for(session.call_tool(b.name, b.input or {}), timeout=120)
    text, is_error = result_text(r), bool(getattr(r, "isError", False))
except asyncio.TimeoutError:
    text, is_error = "The query took too long.", True`,
    },
    related: ["exasol-mcp-server", "ask-credora"],
  },
  "ask-credora": {
    id: "ask-credora",
    term: "Ask Credora",
    kind: "ai",
    plain: "Plain-English questions about the analysis, answered by Claude with the exact SQL it ran.",
    inExasol: "Answers come from the semantic view CREDORA_SEM.PORTFOLIO first, then plain SQL where the role's grants allow. The MCP server logs in as the signed-in role's Exasol user, so Exasol decides what the AI can read.",
    objects: ["CREDORA_SEM.PORTFOLIO", "CREDORA_ADMIN", "CREDORA_RM"],
    related: ["exasol-mcp-server", "topic-gate", "semantic-view", "mcp-tool-call"],
  },
  "topic-gate": {
    id: "topic-gate",
    term: "Ask Credora topic gate",
    kind: "ai",
    plain: "A quick check that refuses questions that are not about Credora's analysis, before any data is touched.",
    inExasol: "_on_topic() makes one Claude call that must reply IN or OUT. An OUT question gets a fixed refusal and no MCP server is started, so it never reaches Exasol.",
    code: {
      lang: "python",
      file: "backend/app/assistant.py",
      snippet: `async def _on_topic(client: Any, question: str) -> bool:
    """A one-word classification call before any tool use; unrelated questions never reach Exasol."""
    try:
        resp = await asyncio.to_thread(
            client.messages.create, model=settings.ai_model, max_tokens=5, system=SCOPE_PROMPT,
            messages=[{"role": "user", "content": question}])
    except Exception as e:  # noqa: BLE001 - if the filter itself fails, the main prompt's scope rule decides
        log.warning("topic check failed: %s", e)
        return True
    verdict = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip().upper()
    return not verdict.startswith("OUT")`,
    },
    related: ["ask-credora", "exasol-mcp-server"],
  },
  "risk-model": {
    id: "risk-model",
    term: "Risk model (champion)",
    kind: "ai",
    plain: "A machine-learning model trained on the bank's 5,000 past loans that estimates how likely each company is to default.",
    inExasol: "CREDORA.TRAIN_PD trains gradient-boosted trees (scikit-learn HistGradientBoosting with monotonic constraints) in a Python UDF on VS_LOS.\"past_loan_training\", read live from PostgreSQL. Step 9 scores every company with CREDORA.PD_SCORE, which also returns each feature's effect on the PD.",
    objects: ["CREDORA.TRAIN_PD", "CREDORA.PD_SCORE", "CREDORA.SCORES", "VS_LOS"],
    code: {
      lang: "lua",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `step(9, 'Score probability of default (ML UDF)', function()
  return rows(query([[
    INSERT INTO CREDORA.SCORES
    SELECT :r, app_id, :mv, pd,
           CASE WHEN pd < 0.01 THEN 'A1' WHEN pd < 0.02 THEN 'A2' WHEN pd < 0.035 THEN 'B1' WHEN pd < 0.05 THEN 'B2'
                WHEN pd < 0.08 THEN 'C1' WHEN pd < 0.12 THEN 'C2' ELSE 'D' END,
           contributions
    FROM (SELECT CREDORA.PD_SCORE(:mp, APP_ID, GST_YEARS, GST_TURNOVER_12M, GST_LATE_FILINGS_12M, GST_BANK_GAP_PCT,
                                  AVG_BALANCE_12M, INFLOW_VOLATILITY, BOUNCE_RATIO, CMR_RANK, PARTNER_MIN_SCORE,
                                  PARTNER_AVG_SCORE, PARTNER_OVERDUE_AMT, PARTNER_OTHER_BANK_BAL, DSCR)
          FROM CREDORA.FEATURES WHERE RUN_ID = :r GROUP BY MOD(ASCII(SUBSTR(HASH_MD5(APP_ID), 1, 1)), 4))]],
    {r = run_id, mv = model_version, mp = model_path}))`,
    },
    related: ["pd", "grade", "model-registry", "challenger-model"],
  },
  "rds": {
    id: "rds",
    term: "Amazon RDS (Oracle, MySQL, PostgreSQL)",
    kind: "aws",
    plain: "Managed databases on AWS. They stand in for Sapphire Bank's real systems.",
    inExasol: "RDS for Oracle holds core banking (schema CBS), MySQL holds the customer master (cif) and PostgreSQL holds loan origination (los) and the CRM (crm). Exasol reads the first three through VS_CBS, VS_CIF and VS_LOS as read-only database users. The databases sit in private subnets.",
    objects: ["VS_CBS", "VS_CIF", "VS_LOS", "ORA_CBS", "MYSQL_CIF", "PG_LOS"],
    related: ["virtual-schema", "crm"],
  },
  "ec2-app-host": {
    id: "ec2-app-host",
    term: "EC2 app host",
    kind: "aws",
    plain: "The AWS server that runs the web app, its API, the mock CIBIL, GSTN and Account Aggregator services and the data generator.",
    inExasol: "It is separate from the Exasol EC2 instance. The backend on it connects to Exasol on port 8563 with pyexasol, one session pool per Exasol user.",
    objects: ["CREDORA_SVC", "CREDORA_ADMIN"],
    related: ["exasol-personal-aws", "sessions"],
  },
  "route53": {
    id: "route53",
    term: "Route 53 (credora.loan, credora.link)",
    kind: "aws",
    plain: "AWS's DNS service. It points the web addresses to the right servers.",
    inExasol: "credora.loan serves the app. credora.link serves the 3rd party data APIs. cibil., gst. and aa.credora.link are the HTTPS endpoints that the MOCK_CIBIL, MOCK_GSTN and MOCK_AA connections call to fetch 3rd party data on demand.",
    objects: ["MOCK_CIBIL", "MOCK_GSTN", "MOCK_AA"],
    related: ["connection-object", "ec2-app-host"],
  },
  "secrets-manager": {
    id: "secrets-manager",
    term: "AWS Secrets Manager",
    kind: "aws",
    plain: "AWS's safe for passwords and keys.",
    inExasol: "OpenTofu generates each deployment's runtime secret there. The deploy tool reads it to set the Exasol users' passwords and to fill the CONNECTION objects, so no secret is in the repo.",
    objects: ["CREDORA_SVC", "ORA_CBS"],
    related: ["user", "connection-object"],
  },
  "crm": {
    id: "crm",
    term: "CRM (PostgreSQL crm)",
    kind: "app",
    plain: "Sapphire Bank's offer tracker. It holds every offer, who changed it, and the audit log.",
    inExasol: "After each analysis the backend reads CREDORA.DECISIONS as CREDORA_SVC and upserts crm.offer in PostgreSQL. Negotiation and checker actions change crm.offer and crm.offer_event, not Exasol.",
    objects: ["CREDORA.DECISIONS"],
    related: ["offer-stages", "rds"],
  },
  "offer-stages": {
    id: "offer-stages",
    term: "Offer stages",
    kind: "app",
    plain: "Where an offer is in its life, which is OFFERED, NEGOTIATING, ESCALATED, VERIFIED, SANCTIONED or DECLINED.",
    inExasol: "Stages live in crm.offer. A new analysis replaces only OFFERED and DECLINED offers. Offers in negotiation or beyond keep their terms.",
    code: {
      lang: "python",
      file: "backend/app/routes/offers.py",
      snippet: `CHECKER = {
    "verify": (("NEGOTIATING", "ESCALATED"), "VERIFIED", "VERIFY"),
    "sanction": (("VERIFIED",), "SANCTIONED", "SANCTION"),
    "reject": (("OFFERED", "NEGOTIATING", "ESCALATED", "VERIFIED"), "DECLINED", "REJECT"),
}`,
    },
    related: ["maker-checker", "crm", "loan-status"],
  },
  "what-if": {
    id: "what-if",
    term: "What-if",
    kind: "app",
    plain: "Try different policy numbers and see at once how many companies would be approved, referred or declined.",
    inExasol: "One SELECT, run as the data scientist's own user CREDORA_DATASCI, replays the decision SQL over the current run's stored FEATURES and SCORES with overridden CONFIG values. Nothing is written to Exasol, and saved runs go to crm.whatif_run.",
    objects: ["CREDORA.CONFIG", "CREDORA.FEATURES", "CREDORA.SCORES", "CREDORA.DECISIONS"],
    related: ["policy-config", "policy-proposal"],
  },
  "policy-proposal": {
    id: "policy-proposal",
    term: "Policy proposal",
    kind: "app",
    plain: "The data scientist proposes new policy numbers from a what-if run, and the admin approves or rejects them.",
    inExasol: "Proposals live in crm.policy_proposal. On approval one job runs UPDATE CREDORA.CONFIG as CREDORA_SVC and then a full official CREDORA.RUN_ANALYSIS, so decisions, offers and the semantic layer follow the new policy.",
    objects: ["CREDORA.CONFIG", "CREDORA.RUN_ANALYSIS"],
    code: {
      lang: "python",
      file: "backend/app/policy.py",
      snippet: `CONFIG_STEP_NAME = "Write the approved policy to CREDORA.CONFIG (as CREDORA_SVC)"`,
    },
    related: ["what-if", "maker-checker", "policy-config"],
  },
  "model-activation-approval": {
    id: "model-activation-approval",
    term: "Model activation approval",
    kind: "app",
    plain: "The data scientist requests a switch of the deciding model, and the admin approves before it takes effect.",
    inExasol: "Requests live in the CRM (crm.model_activation_request), with one pending request per version, and nobody decides their own. Approval runs UPDATE CREDORA.MODEL_REGISTRY SET IS_ACTIVE as CREDORA_SVC. It is refused if another model became active after the request.",
    objects: ["CREDORA.MODEL_REGISTRY"],
    related: ["model-activation", "maker-checker"],
  },
  "loan-status": {
    id: "loan-status",
    term: "Loan status tracking",
    kind: "app",
    plain: "After the offer, the relationship manager records what happened. The statuses are Contacted, Negotiating, Loan taken, In progress, then Disbursed or Not interested.",
    inExasol: "Each change is a new row in CREDORA.LOAN_STATUS_LOG, written as CREDORA_SVC with a note, who and when. The newest row is the current status. The RM reads the history back through the row-filtered view CREDORA.V_RM_LOAN_STATUS. After Disbursed the status no longer changes.",
    objects: ["CREDORA.LOAN_STATUS_LOG", "CREDORA.V_RM_LOAN_STATUS"],
    code: {
      lang: "sql",
      file: "exasol/sql/13_rm_row_security.sql",
      snippet: `CREATE OR REPLACE VIEW CREDORA.V_RM_LOAN_STATUS AS
SELECT l.EVENT_ID, l.CIF_ID, l.RM_ID, l.STATUS, l.NOTE, l.LOGGED_BY, l.LOGGED_AT
FROM CREDORA.LOAN_STATUS_LOG l
JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = l.CIF_ID AND a.EXA_USER = CURRENT_USER;`,
    },
    related: ["offer-stages", "disbursal"],
  },
  "audit-log": {
    id: "audit-log",
    term: "Audit log",
    kind: "app",
    plain: "A record of who did what and when, such as logins, runs, reports viewed, proposals and approvals.",
    inExasol: "There are two logs. For the app, the backend writes crm.audit_event for each action (for example RUN_ANALYSIS, TRAIN_MODEL, VIEW_REPORT, ASK_CREDORA). For the database, Exasol's own audit log records every statement and session (EXA_DBA_AUDIT_SQL, EXA_DBA_AUDIT_SESSIONS), shown on the admin's Exasol audit screen. The purge proof is separate, in CREDORA.PURGE_LOG.",
    objects: ["CREDORA.PURGE_LOG", "EXA_DBA_AUDIT_SQL", "EXA_DBA_AUDIT_SESSIONS"],
    related: ["purge-proof", "crm", "exasol-audit"],
  },
  "exasol-audit": {
    id: "exasol-audit",
    term: "Exasol audit log",
    kind: "exasol",
    plain: "Exasol's own record of every statement. It shows who ran it, when, how long it took, how much CPU and memory it used, and whether it worked. The regulator's \"who ran what\", proven by the database, not by the app.",
    inExasol: "Auditing is on. Every Credora session and statement is tagged credora:<app user>:<feature> (the session's client name and a leading SQL comment), so each audited row names the person and the screen or job. The admin reads EXA_DBA_AUDIT_SQL joined with EXA_DBA_AUDIT_SESSIONS as CREDORA_ADMIN (SELECT ANY DICTIONARY). The screen also shows one RUN_ANALYSIS with each step's COMMIT.",
    objects: ["EXA_DBA_AUDIT_SQL", "EXA_DBA_AUDIT_SESSIONS", "CREDORA_ADMIN"],
    code: {
      lang: "sql",
      file: "backend/app/exasol_admin.py",
      snippet: `SELECT q.START_TIME, s.USER_NAME, s.CLIENT, q.CONSUMER_GROUP, q.SQL_TEXT,
       q.CPU, q.TEMP_DB_RAM_PEAK, q.DURATION, q.SUCCESS
FROM EXA_DBA_AUDIT_SQL q JOIN EXA_DBA_AUDIT_SESSIONS s ON s.SESSION_ID = q.SESSION_ID
WHERE s.USER_NAME LIKE 'CREDORA\\_%' AND q.SQL_TEXT LIKE '/*credora:loanops:%'`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/auditing.htm",
    related: ["audit-log", "consumer-group", "select-any-dictionary", "sessions"],
  },
  "explain-virtual": {
    id: "explain-virtual",
    term: "EXPLAIN VIRTUAL",
    kind: "exasol",
    plain: "Asks Exasol which SQL it would send to a source database for a query on a virtual schema, without running the query. The proof that work is pushed down.",
    inExasol: "The Sources screen runs EXPLAIN VIRTUAL live on the analysis's reads. For core banking, Oracle receives the join, the filter and the GROUP BY per account and month. For the credit needs on file, PostgreSQL and MySQL each receive their own projection, and Exasol joins the results.",
    objects: ["VS_CBS", "VS_CIF", "VS_LOS"],
    code: {
      lang: "sql",
      file: "backend/app/exasol_admin.py",
      snippet: `EXPLAIN VIRTUAL
SELECT t.ACCOUNT_NO, TO_CHAR(t.TXN_DATE, 'YYYY-MM') MON, SUM(t.AMOUNT), COUNT(*)
FROM VS_CBS.TXN t JOIN VS_CBS.ACCOUNT a ON a.ACCOUNT_NO = t.ACCOUNT_NO
WHERE a.ACCT_TYPE = 'CA'
GROUP BY t.ACCOUNT_NO, TO_CHAR(t.TXN_DATE, 'YYYY-MM')`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/explain_virtual.htm",
    related: ["pushdown", "virtual-schema"],
  },
  "comment-on": {
    id: "comment-on",
    term: "COMMENT ON",
    kind: "exasol",
    plain: "Stores a plain-English description on a table, column, schema or script, inside the database, where every SQL tool and AI can read it.",
    inExasol: "Every Credora table and column (CREDORA, CREDORA_STAGE), both schemas and every script and UDF carry their meaning from the glossary. The Exasol MCP server's describe tools return these comments to Ask Credora. Views can be commented only in CREATE VIEW.",
    objects: ["EXA_ALL_COLUMNS.COLUMN_COMMENT", "EXA_ALL_TABLES.TABLE_COMMENT", "EXA_ALL_SCRIPTS.SCRIPT_COMMENT"],
    code: {
      lang: "sql",
      file: "exasol/sql/15_comments.sql",
      snippet: `COMMENT ON TABLE CREDORA.PURGE_LOG IS 'Proof of deletion: ...' (
  ROWS_DELETED IS 'How many rows were deleted',
  SHA256 IS 'SHA-256 of the deleted rows'' key fields, in a fixed order'
);`,
    },
    docs: "https://docs.exasol.com/db/latest/sql/comment.htm",
    related: ["exasol-mcp-server", "system-tables"],
  },
  "consumer-group": {
    id: "consumer-group",
    term: "Consumer group",
    kind: "exasol",
    plain: "Exasol's workload management. Users are put in groups that get a share of CPU, a priority, a statement time limit and a memory limit.",
    inExasol: "CREDORA_BATCH (high priority) is for CREDORA_SVC, which runs the analysis, training and the scheduled jobs. CREDORA_APP (medium, 5-minute limit) is for the four role users behind the screens. CREDORA_AI (low, 60 s, 2 GiB per session) is for CREDORA_MCP. Ask Credora's sessions as a role user get the same AI limits per session. The AI cannot starve or hang the bank's analysis.",
    objects: ["EXA_CONSUMER_GROUPS", "CREDORA_BATCH", "CREDORA_APP", "CREDORA_AI"],
    code: {
      lang: "sql",
      file: "exasol/sql/16_resources.sql",
      snippet: `ALTER CONSUMER GROUP CREDORA_AI SET PRECEDENCE = '100', CPU_WEIGHT = '100', QUERY_TIMEOUT = 60,
  SESSION_TEMP_DB_RAM_LIMIT = '2G', GROUP_TEMP_DB_RAM_LIMIT = '4G';
ALTER USER CREDORA_SVC SET CONSUMER_GROUP = CREDORA_BATCH;`,
    },
    docs: "https://docs.exasol.com/db/latest/database_concepts/resource_manager.htm",
    related: ["query-timeout", "exasol-audit", "user"],
  },
  "query-timeout": {
    id: "query-timeout",
    term: "QUERY_TIMEOUT",
    kind: "exasol",
    plain: "The longest a single statement may run before Exasol cancels it.",
    inExasol: "Ask Credora's MCP sessions run ALTER SESSION SET QUERY_TIMEOUT = 60 (with NICE and a 2 GiB temporary-memory limit) as soon as they open. CREDORA_AI and CREDORA_APP carry a limit at group level too. A runaway AI query ends with \"Query terminated because timeout has been reached\".",
    objects: ["EXA_PARAMETERS", "CREDORA_AI"],
    code: {
      lang: "python",
      file: "backend/app/assistant.py",
      snippet: `AI_SESSION_SQL = [
    "ALTER SESSION SET QUERY_TIMEOUT = 60",
    "ALTER SESSION SET NICE = 'ON'",
    "ALTER SESSION SET SESSION_TEMP_DB_RAM_LIMIT = '2G'",
]`,
    },
    related: ["consumer-group", "exasol-mcp-server"],
  },
  "exasol-scheduler": {
    id: "exasol-scheduler",
    term: "Exasol Scheduler",
    kind: "exasol",
    plain: "An open-source scheduler from exasol-labs whose jobs are rows in an Exasol table. You define jobs in SQL, run them with SQL, audit them with SQL.",
    inExasol: "One container on the app host (pinned v0.4.1) runs SCHED.SCHED_TASKS as CREDORA_SVC. It runs PURGE_EXPIRED every 15 minutes, and a nightly refresh of the three virtual schemas (VS_CIF and VS_LOS as finalizers, so they run even if Oracle fails). Every run is a row in SCHED.SCHED_HISTORY, shown on the Exasol audit screen.",
    objects: ["SCHED.SCHED_TASKS", "SCHED.SCHED_HISTORY", "CREDORA.PURGE_EXPIRED"],
    code: {
      lang: "sql",
      file: "exasol/sql/17_scheduler.sql",
      snippet: `SELECT "TASK_ID", "SCHEDULE", "SQL_TEXT" FROM SCHED.SCHED_TASKS;
-- credora_purge_expired | CRON 0 */15 * * * * TZ=Asia/Kolkata | EXECUTE SCRIPT CREDORA.PURGE_EXPIRED()`,
    },
    docs: "https://github.com/exasol-labs/exasol-scheduler",
    related: ["purge-proof", "lua-script", "vs-refresh"],
  },
  "preprocessor-library": {
    id: "preprocessor-library",
    term: "Preprocessor library",
    kind: "exasol",
    plain: "Ready-made SQL rewrites from exasol-labs, installed into Exasol with one statement through the preprocessor framework.",
    inExasol: "cast_shorthand (x::DECIMAL(6,4) becomes CAST(x AS DECIMAL(6,4))) and trailing_comma (SELECT a, b, FROM t still works), pinned to release v0.3.1, for the roles whose sessions send AI-written SQL. They run before the semantic layer, so Claude's PostgreSQL habits reach Exasol as valid SQL. The service user's own SQL is never rewritten.",
    objects: ["PREPROC_RT.CAST_SHORTHAND_V1", "PREPROC_RT.ERGONOMICS_TRAILING_COMMA_V2", "PREPROC_RT.INSTALLED_MODULES"],
    code: {
      lang: "sql",
      file: "deploy/exasol_setup.py",
      snippet: `PREPROC INSTALL MODULE cast_shorthand
  FROM 'https://raw.githubusercontent.com/exasol-labs/preprocessor-library/v0.3.1/registry/index.json'
  FOR ROLE R_DATASCI;`,
    },
    docs: "https://github.com/exasol-labs/preprocessor-library",
    related: ["sql-preprocessor", "semantic-view", "exasol-mcp-server"],
  },
  "mock-data": {
    id: "mock-data",
    term: "Mock data generator",
    kind: "app",
    plain: "Builds a fresh synthetic Sapphire Bank with companies, partners, accounts, transactions, GST returns, credit reports. All data is invented.",
    inExasol: "It writes to the RDS databases and the databases behind the mock 3rd party APIs, not to Exasol. Exasol sees the new rows through the virtual schemas at the next query, and RUN_ANALYSIS step 1 refreshes their metadata.",
    objects: ["VS_CBS", "VS_CIF", "VS_LOS"],
    related: ["virtual-schema", "vs-refresh"],
  },
  "exasol-report": {
    id: "exasol-report",
    term: "Exasol report",
    kind: "app",
    plain: "One page per company that shows the decision, why, the features the model saw, the sources used and every step Exasol ran.",
    inExasol: "Read as the signed-in role's Exasol user from DECISIONS, SCORES (CONTRIBUTIONS), FEATURES, ANOMALY and RUN_LOG of the current run. An RM reads the row-filtered V_RM_* views instead.",
    objects: ["CREDORA.DECISIONS", "CREDORA.SCORES", "CREDORA.RUN_LOG"],
    related: ["run-log", "credit-memo-udf"],
  },
  "pre-approved-offer": {
    id: "pre-approved-offer",
    term: "Pre-approved offer",
    kind: "banking",
    plain: "The bank approaches an existing customer with a loan already decided, meaning an amount, a rate and a tenure, before the customer comes in.",
    inExasol: "A decision of APPROVE in CREDORA.DECISIONS with OFFER_AMOUNT, OFFER_ROI and OFFER_TENURE. The certified metric pre_approved_amount sums them.",
    objects: ["CREDORA.DECISIONS", "CREDORA_SEM.PORTFOLIO"],
    code: {
      lang: "sql",
      file: "exasol/semantic/12_credora_model.sql",
      snippet: `METRIC pre_approved_amount AS SUM(offer_amount) ON ENTITY decision RETURNS DECIMAL(18,2)
  FILTER (WHERE decision = ''APPROVE'')
  FORMAT ''currency'' DISPLAY ''Pre-approved amount'' COMMENT ''Sum of pre-approved offer amounts (APPROVE only), INR''`,
    },
    related: ["indicated-need", "negotiation-limit", "approve-refer-decline"],
  },
  "indicated-need": {
    id: "indicated-need",
    term: "Indicated need / credit need on file",
    kind: "banking",
    plain: "What the company has told the bank it might need, with product, amount, tenure and purpose. It is the starting point, and the offer can be smaller.",
    inExasol: "Read live from PostgreSQL through VS_LOS.\"application\" in step 2 (Read applications) and stored in CREDORA.APPLICATIONS (AMOUNT_REQUESTED, TENURE_REQUESTED, PRODUCT).",
    objects: ["VS_LOS", "CREDORA.APPLICATIONS"],
    related: ["pre-approved-offer", "working-capital", "term-loan"],
  },
  "explain-mode": {
    id: "explain-mode",
    term: "Explain mode",
    kind: "app",
    plain: "A switch in the top bar that shows what Exasol does behind every screen. It adds hints next to numbers, a band under each page header, a note for each action and the live Exasol console. Off, Credora looks like a plain CRM.",
    inExasol: "Nothing changes in Exasol. Explain mode only shows what already happens. The choice is remembered per viewer in the browser.",
    related: ["exasol-console", "control-room", "user"],
  },
  "exasol-console": {
    id: "exasol-console",
    term: "Exasol console",
    kind: "app",
    plain: "A drawer at the bottom of the screen that lists, live, every statement the backend ran in Exasol for this browser tab.",
    inExasol: "backend/app/exa.py records each statement with the Exasol user it ran as, its time in milliseconds, its row count and any error, in a small ring buffer per signed-in person (the latest 200). Jobs add their RUN_LOG steps and model registry switches, and Ask Credora adds each MCP tool call. Passwords and secret-looking literals are masked before anything is kept. The browser polls GET /api/exasol/console for its own entries only. The admin may also see everyone's.",
    objects: ["CREDORA_ADMIN", "CREDORA_DATASCI", "CREDORA_LOANOPS", "CREDORA_RM", "CREDORA_SVC"],
    code: {
      lang: "python",
      file: "backend/app/exa.py",
      snippet: `def _trace(conn, user, sql, params, t0, rows, error=None):
    shown = conn.format.format(sql, **params) if params else sql
    console.statement(user, shown, (time.perf_counter() - t0) * 1000, rows, error)`,
    },
    related: ["sessions", "user", "run-log", "mcp-tool-call"],
  },
  "control-room": {
    id: "control-room",
    term: "Exasol control room",
    kind: "app",
    plain: "A live map of the database, with its schemas, virtual schemas, scripts and their language containers, connections, the model registry, roles and grants, the preprocessor, the semantic model and the latest run.",
    inExasol: "GET /api/exasol/control-room reads Exasol's system tables (EXA_ALL_SCHEMAS, EXA_ALL_OBJECTS, EXA_ALL_VIRTUAL_SCHEMAS, EXA_ALL_SCRIPTS, EXA_ALL_CONNECTIONS, EXA_PARAMETERS, SEMANTIC_CATALOG) as the signed-in role's own Exasol user, so each role sees what its grants allow. The admin also reads EXA_DBA_* and EXA_DBA_SESSIONS through SELECT ANY DICTIONARY. Cached for a few seconds per role.",
    objects: ["EXA_ALL_SCHEMAS", "EXA_ALL_OBJECTS", "EXA_ALL_VIRTUAL_SCHEMAS", "EXA_ALL_SCRIPTS", "EXA_DBA_SESSIONS"],
    related: ["system-tables", "select-any-dictionary", "grant", "explain-mode"],
  },
  "pd": {
    id: "pd",
    term: "PD (probability of default)",
    kind: "banking",
    plain: "The chance, from 0 to 1, that the company will not repay. 0.03 means 3 in 100 similar companies default.",
    inExasol: "PD_SCORE writes it to CREDORA.SCORES.PD in step 9. It drives the grade, the expected loss and the rate.",
    objects: ["CREDORA.SCORES", "CREDORA.PD_SCORE"],
    related: ["grade", "risk-model", "lgd", "raroc"],
  },
  "grade": {
    id: "grade",
    term: "Risk grade",
    kind: "banking",
    plain: "A letter grade from the PD. A1 is safest, then A2, B1, B2, C1, C2 and D.",
    inExasol: "Set in SQL in step 9. A1 is below 1%, A2 below 2%, B1 below 3.5%, B2 below 5%, C1 below 8%, C2 below 12%, else D. Grades C2 and D are referred.",
    objects: ["CREDORA.SCORES", "CREDORA.DECISIONS"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `CASE WHEN pd < 0.01 THEN 'A1' WHEN pd < 0.02 THEN 'A2' WHEN pd < 0.035 THEN 'B1' WHEN pd < 0.05 THEN 'B2'
     WHEN pd < 0.08 THEN 'C1' WHEN pd < 0.12 THEN 'C2' ELSE 'D' END`,
    },
    related: ["pd", "spread"],
  },
  "raroc": {
    id: "raroc",
    term: "RAROC",
    kind: "banking",
    plain: "Risk-adjusted return on capital. It is what the loan earns after funding cost, running cost and expected loss, divided by the capital the bank must hold.",
    inExasol: "Computed in the decision step as (ROI - FUNDS_COST_PCT - OPEX_PCT - PD x LGD_PCT) / CAPITAL_PCT x 100, at the offer rate (RAROC_OFFER) and at the floor rate (RAROC_FLOOR).",
    objects: ["CREDORA.DECISIONS", "CREDORA.CONFIG"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `ROUND((OFFER_ROI_RAW - FUNDS - OPEX - PD * LGD) / CAPITAL * 100, 3),`,
    },
    related: ["hurdle-rate", "floor-roi", "pd", "lgd"],
  },
  "hurdle-rate": {
    id: "hurdle-rate",
    term: "Hurdle rate",
    kind: "banking",
    plain: "The minimum RAROC the bank accepts on any loan. Below it, the loan is not worth the capital.",
    inExasol: "CONFIG HURDLE_PCT, 15% by default. The floor ROI is set so RAROC at the floor still meets it. The RM's quote checks RAROC against it.",
    objects: ["CREDORA.CONFIG"],
    code: {
      lang: "sql",
      file: "exasol/sql/01_schemas.sql",
      snippet: `SELECT 'HURDLE_PCT', 15.00, 'Minimum RAROC the bank accepts, %' FROM DUAL UNION ALL`,
    },
    related: ["raroc", "floor-roi", "policy-config"],
  },
  "eblr": {
    id: "eblr",
    term: "EBLR",
    kind: "banking",
    plain: "External benchmark lending rate. It is the base interest rate, linked to the central bank's repo rate, on which loan rates are built.",
    inExasol: "CONFIG EBLR_PCT, 8.25% by default. Every offer rate starts from it.",
    objects: ["CREDORA.CONFIG"],
    code: {
      lang: "sql",
      file: "exasol/sql/01_schemas.sql",
      snippet: `SELECT 'EBLR_PCT' k, 8.25 v, 'External benchmark lending rate (repo-linked), % p.a.' d FROM DUAL UNION ALL
SELECT 'OPERATING_SPREAD_PCT', 0.75, 'Operating spread added to every loan, % p.a.' FROM DUAL UNION ALL`,
    },
    related: ["spread", "floor-roi", "roi"],
  },
  "spread": {
    id: "spread",
    term: "Spread",
    kind: "banking",
    plain: "The extra interest added on top of the base rate to pay for risk and running costs.",
    inExasol: "Offer rate = EBLR + risk spread by grade (1.00% for A1 up to 7.00% for D) + operating spread 0.75%, minus 0.25% when collateral covers the amount.",
    objects: ["CREDORA.CONFIG", "CREDORA.DECISIONS"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `CASE s.GRADE WHEN 'A1' THEN 1.00 WHEN 'A2' THEN 1.50 WHEN 'B1' THEN 2.25 WHEN 'B2' THEN 3.00
             WHEN 'C1' THEN 4.00 WHEN 'C2' THEN 5.25 ELSE 7.00 END RISK_SPREAD,`,
    },
    related: ["eblr", "grade", "roi"],
  },
  "roi": {
    id: "roi",
    term: "ROI (rate of interest)",
    kind: "banking",
    plain: "The yearly interest rate on the loan, in % per year.",
    inExasol: "OFFER_ROI in CREDORA.DECISIONS is the rate-card rate, raised to the floor ROI if the floor is higher.",
    objects: ["CREDORA.DECISIONS"],
    related: ["spread", "floor-roi"],
  },
  "floor-roi": {
    id: "floor-roi",
    term: "Floor ROI",
    kind: "banking",
    plain: "The lowest rate the RM may agree to in negotiation.",
    inExasol: "The higher of EBLR + FLOOR_MARGIN_PCT and the rate at which RAROC equals the hurdle, rounded up to 0.05%. Stored as DECISIONS.FLOOR_ROI.",
    objects: ["CREDORA.DECISIONS", "CREDORA.CONFIG"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `CEIL((GREATEST(EBLR + FLOOR_MARGIN, HURDLE * CAPITAL / 100 + FUNDS + OPEX + PD * LGD)) * 20) / 20 FLOOR_ROI_RAW,`,
    },
    related: ["negotiation-limit", "hurdle-rate", "raroc"],
  },
  "negotiation-limit": {
    id: "negotiation-limit",
    term: "Negotiation limit",
    kind: "banking",
    plain: "How far the RM may move without going back to credit, as the lowest rate, highest amount and longest tenure.",
    inExasol: "Stored per company as FLOOR_ROI, MAX_AMOUNT (at most 1.15 x the indicated need, with DSCR at least NEGOTIATION_DSCR) and MAX_TENURE in CREDORA.DECISIONS. A proposal outside it is ESCALATED.",
    objects: ["CREDORA.DECISIONS"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `FLOOR(LEAST(AMOUNT_REQUESTED * 1.15, GREATEST(CAP_MAX, 0)) / 100000) * 100000 MAX_AMT,`,
    },
    related: ["floor-roi", "dscr", "offer-stages"],
  },
  "dscr": {
    id: "dscr",
    term: "DSCR",
    kind: "banking",
    plain: "Debt service coverage ratio. It is the cash the business earns divided by the loan payments due. Above 1 means it can pay.",
    inExasol: "A feature in CREDORA.FEATURES, computed as 12% of 12-month GST turnover over the yearly payment on the indicated need at 11%. The offer amount keeps DSCR at least MIN_DSCR (1.25), and the negotiation limit at least NEGOTIATION_DSCR (1.10).",
    objects: ["CREDORA.FEATURES", "CREDORA.CONFIG"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `COALESCE(gst.TURNOVER, 0) * 0.12 /
  CASE WHEN app.PRODUCT = 'TL'
       THEN 12 * app.AMOUNT_REQUESTED * (0.11 / 12) / (1 - POWER(1 + 0.11 / 12, -app.TENURE_REQUESTED))
       ELSE app.AMOUNT_REQUESTED * 0.11 END,`,
    },
    related: ["negotiation-limit", "gst-returns"],
  },
  "lgd": {
    id: "lgd",
    term: "LGD (loss given default)",
    kind: "banking",
    plain: "If a borrower defaults, the share of the loan the bank expects to lose after recovery.",
    inExasol: "CONFIG LGD_PCT, 45% by default. Used in RAROC, the floor ROI and the certified metric expected_loss.",
    objects: ["CREDORA.CONFIG"],
    related: ["expected-loss", "raroc"],
  },
  "expected-loss": {
    id: "expected-loss",
    term: "Expected loss",
    kind: "banking",
    plain: "The loss to expect on average, which is PD x LGD x amount.",
    inExasol: "Certified metric expected_loss in CREDORA_SEM.PORTFOLIO, summed over offers.",
    objects: ["CREDORA_SEM.PORTFOLIO"],
    related: ["pd", "lgd", "certified-metric"],
  },
  "cmr-rank": {
    id: "cmr-rank",
    term: "CMR rank",
    kind: "banking",
    plain: "CIBIL's company credit rank from 1 (best) to 10 (worst).",
    inExasol: "Fetched by CIBIL_COMMERCIAL_FETCH into CREDORA_STAGE.CIBIL_COMMERCIAL and copied to FEATURES.CMR_RANK. Rank 9 or 10 is a hard fail.",
    objects: ["CREDORA_STAGE.CIBIL_COMMERCIAL", "CREDORA.FEATURES"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `CASE WHEN CMR_RANK >= 9 THEN 'CIBIL CMR rank ' || CMR_RANK || ';' ELSE '' END ||`,
    },
    related: ["cibil-commercial", "hard-fail"],
  },
  "cibil-consumer": {
    id: "cibil-consumer",
    term: "CIBIL consumer report",
    kind: "banking",
    plain: "A person's credit report from the bureau CIBIL, with score, loans, overdues and payment history. Credora pulls it for every partner of a company.",
    inExasol: "Step 3 calls CREDORA.CIBIL_CONSUMER_FETCH through CONNECTION MOCK_CIBIL into CREDORA_STAGE.CIBIL_CONSUMER. Step 7 derives PARTNER_MIN_SCORE, PARTNER_AVG_SCORE and PARTNER_OVERDUE_AMT.",
    objects: ["CREDORA.CIBIL_CONSUMER_FETCH", "CREDORA_STAGE.CIBIL_CONSUMER", "MOCK_CIBIL"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `MIN(CASE WHEN c.SCORE = -1 THEN 650 ELSE c.SCORE END) MIN_SCORE,`,
    },
    related: ["cibil-commercial", "hard-fail"],
  },
  "cibil-commercial": {
    id: "cibil-commercial",
    term: "CIBIL commercial report",
    kind: "banking",
    plain: "The company's own credit report from CIBIL, with CMR rank, total exposure, overdue, suits and wilful default.",
    inExasol: "Step 4 calls CREDORA.CIBIL_COMMERCIAL_FETCH through CONNECTION MOCK_CIBIL into CREDORA_STAGE.CIBIL_COMMERCIAL.",
    objects: ["CREDORA.CIBIL_COMMERCIAL_FETCH", "CREDORA_STAGE.CIBIL_COMMERCIAL"],
    related: ["cmr-rank", "wilful-default", "suit-filed"],
  },
  "gstn": {
    id: "gstn",
    term: "GSTN",
    kind: "banking",
    plain: "The Goods and Services Tax Network, India's system where businesses register for GST and file their returns.",
    inExasol: "Step 5 calls CREDORA.GST_FETCH through CONNECTION MOCK_GSTN (the gst.credora.link 3rd party data API) into CREDORA_STAGE.GST_FILING.",
    objects: ["CREDORA.GST_FETCH", "MOCK_GSTN", "CREDORA_STAGE.GST_FILING"],
    related: ["gst-returns", "gstr-1", "gstr-3b"],
  },
  "gst-returns": {
    id: "gst-returns",
    term: "GST returns",
    kind: "banking",
    plain: "The monthly tax filings a business makes. They show its sales and whether it files on time.",
    inExasol: "Step 7 uses the last 12 returns before the credit need was recorded. GST_TURNOVER_12M comes from GSTR-1 and GST_LATE_FILINGS_12M from filed and due dates. 4 or more late returns is a hard fail.",
    objects: ["CREDORA_STAGE.GST_FILING", "CREDORA.FEATURES"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `SUM(CASE WHEN FILED_ON IS NULL OR FILED_ON > DUE_DATE THEN 1 ELSE 0 END) LATE,`,
    },
    related: ["gstr-1", "gstr-3b", "gst-bank-gap"],
  },
  "gstr-1": {
    id: "gstr-1",
    term: "GSTR-1",
    kind: "banking",
    plain: "The GST return that lists a business's sales for the month.",
    inExasol: "Stored as GST_FILING.GSTR1_TURNOVER. Its 12-month sum is FEATURES.GST_TURNOVER_12M.",
    objects: ["CREDORA_STAGE.GST_FILING"],
    related: ["gst-returns", "gstr-3b"],
  },
  "gstr-3b": {
    id: "gstr-3b",
    term: "GSTR-3B",
    kind: "banking",
    plain: "The monthly GST summary return in which the business declares and pays its tax.",
    inExasol: "Stored as GST_FILING.GSTR3B_TAX_PAID.",
    objects: ["CREDORA_STAGE.GST_FILING"],
    related: ["gst-returns", "gstr-1"],
  },
  "gst-bank-gap": {
    id: "gst-bank-gap",
    term: "GST vs bank gap",
    kind: "banking",
    plain: "How far the sales declared for GST differ from the money that actually came into the bank account. A big gap is a warning sign.",
    inExasol: "FEATURES.GST_BANK_GAP_PCT compares GST turnover with Oracle current-account credits read through VS_CBS. The anomaly model also compares the two.",
    objects: ["CREDORA.FEATURES", "VS_CBS"],
    related: ["gst-returns", "anomaly-flag", "pushdown"],
  },
  "account-aggregator": {
    id: "account-aggregator",
    term: "Account Aggregator (AA)",
    kind: "banking",
    plain: "India's consent-based way to share bank account data between institutions. With the customer's permission, another bank's account data flows to the lender.",
    inExasol: "Step 6 calls CREDORA.AA_FETCH through CONNECTION MOCK_AA (aa.credora.link) for every partner into CREDORA_STAGE.AA_ACCOUNT. FEATURES.PARTNER_OTHER_BANK_BAL sums the balances.",
    objects: ["CREDORA.AA_FETCH", "MOCK_AA", "CREDORA_STAGE.AA_ACCOUNT"],
    code: {
      lang: "python",
      file: "exasol/udf/04_api_udfs.sql",
      snippet: `r = requests.post(f"{conn.address}/v1/fi/bulk", json={"pans": pans[i:i + 200], "purpose": "Loan underwriting"},
                  headers={"X-API-Key": conn.password}, timeout=180)`,
    },
    related: ["consent", "fip", "purge-proof"],
  },
  "consent": {
    id: "consent",
    term: "Consent (AA)",
    kind: "banking",
    plain: "The customer's time-limited permission to share account data. When it expires, the data must go.",
    inExasol: "Each AA_ACCOUNT row gets PURGE_AT = the consent expiry (24 hours in the mock), and PURGE_EXPIRED deletes it after that.",
    objects: ["CREDORA_STAGE.AA_ACCOUNT", "CREDORA.PURGE_EXPIRED"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `COALESCE(consent_expires, ADD_HOURS(SYSTIMESTAMP, 24))`,
    },
    related: ["account-aggregator", "purge-proof"],
  },
  "fip": {
    id: "fip",
    term: "FIP (financial information provider)",
    kind: "banking",
    plain: "The bank or institution that holds the account and sends its data through the Account Aggregator.",
    inExasol: "Stored in CREDORA_STAGE.AA_ACCOUNT.FIP, for example HDFC Bank.",
    objects: ["CREDORA_STAGE.AA_ACCOUNT"],
    related: ["account-aggregator"],
  },
  "wilful-default": {
    id: "wilful-default",
    term: "Wilful default",
    kind: "banking",
    plain: "A borrower that could pay but chose not to. Banks do not lend to wilful defaulters.",
    inExasol: "From the CIBIL commercial report into FEATURES.WILFUL_DEFAULT. A wilful defaulter is a hard fail and is declined.",
    objects: ["CREDORA.FEATURES", "CREDORA_STAGE.CIBIL_COMMERCIAL"],
    related: ["hard-fail", "cibil-commercial"],
  },
  "suit-filed": {
    id: "suit-filed",
    term: "Suit filed",
    kind: "banking",
    plain: "A lender has gone to court to recover money from the company.",
    inExasol: "From the CIBIL commercial report into FEATURES.SUIT_FILED and shown in the report. It is not one of the hard-fail rules.",
    objects: ["CREDORA.FEATURES"],
    related: ["cibil-commercial", "wilful-default"],
  },
  "hard-fail": {
    id: "hard-fail",
    term: "Hard fail",
    kind: "banking",
    plain: "A policy rule that blocks an offer whatever the model says.",
    inExasol: "Wilful defaulter, CMR rank 9 or 10, 4 or more late GST returns in 12 months, a partner's CIBIL score below 600, or a bounce ratio above 8% gives DECLINE. The reasons are stored in DECISIONS.HARD_FAILS.",
    objects: ["CREDORA.DECISIONS"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `CASE WHEN WILFUL_DEFAULT THEN 'Wilful defaulter;' ELSE '' END ||
CASE WHEN CMR_RANK >= 9 THEN 'CIBIL CMR rank ' || CMR_RANK || ';' ELSE '' END ||
CASE WHEN GST_LATE_FILINGS_12M >= 4 THEN GST_LATE_FILINGS_12M || ' late GST returns in 12 months;' ELSE '' END ||
CASE WHEN PARTNER_MIN_SCORE < 600 THEN 'Partner CIBIL ' || PARTNER_MIN_SCORE || ' below 600;' ELSE '' END ||
CASE WHEN BOUNCE_RATIO > 0.08 THEN 'Bounce ratio ' || ROUND(BOUNCE_RATIO * 100, 1) || '%;' ELSE '' END), '') FAILS`,
    },
    related: ["approve-refer-decline", "wilful-default", "cmr-rank"],
  },
  "approve-refer-decline": {
    id: "approve-refer-decline",
    term: "Approve / Refer / Decline",
    kind: "banking",
    plain: "Approve means a pre-approved offer. Refer means an offer that a credit committee reviews first. Decline means no offer.",
    inExasol: "DECLINE on any hard fail. REFER when KYC is not verified, the grade is C2 or D, the offer is under half the indicated need, the hurdle needs a rate above the rate card, or the anomaly model flagged the company. Otherwise APPROVE.",
    objects: ["CREDORA.DECISIONS"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `CASE WHEN FAILS IS NOT NULL THEN 'DECLINE'
     WHEN KYC_STATUS <> 'VERIFIED' OR GRADE IN ('C2', 'D') OR OFFER_AMT < AMOUNT_REQUESTED * 0.5
          OR FLOOR_ROI_RAW > LIST_ROI
          OR OFFER_AMT <= 0 THEN 'REFER'
     WHEN ANOMALY IS NOT NULL THEN 'REFER'  -- unusual figures: a person looks first; never a decline
     ELSE 'APPROVE' END DECISION,`,
    },
    related: ["hard-fail", "kyc", "anomaly-flag"],
  },
  "maker-checker": {
    id: "maker-checker",
    term: "Maker-checker",
    kind: "banking",
    plain: "One person makes a change and a second person checks and approves it. No one can push a decision through alone.",
    inExasol: "For offers, the RM proposes terms and loan operations verifies and sanctions. For policy, the data scientist proposes and the admin approves. Each step is a separate login and a separate Exasol user.",
    related: ["offer-stages", "policy-proposal", "model-activation-approval"],
  },
  "working-capital": {
    id: "working-capital",
    term: "Working capital (WC)",
    kind: "banking",
    plain: "A short-term credit line, usually for 12 months, to fund day-to-day stock and receivables. Interest is paid on what is used.",
    inExasol: "PRODUCT = 'WC'. The offer is capped at MAX_GST_SHARE_PCT (20%) of 12-month GST turnover and by DSCR. Tenure is 12 months.",
    objects: ["CREDORA.DECISIONS", "CREDORA.CONFIG"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `ELSE LEAST(GST_TURNOVER_12M * GST_SHARE / 100, CASH / MIN_DSCR / (GREATEST(LIST_ROI, FLOOR_ROI_RAW) / 100))`,
    },
    related: ["term-loan", "dscr"],
  },
  "term-loan": {
    id: "term-loan",
    term: "Term loan (TL)",
    kind: "banking",
    plain: "A loan for a fixed period, repaid in monthly instalments (EMI), usually to buy equipment or expand.",
    inExasol: "PRODUCT = 'TL'. Tenure is capped at 84 months (60 for grades C1, C2 and D). The amount is sized so the EMI keeps DSCR at least MIN_DSCR.",
    objects: ["CREDORA.DECISIONS"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `CASE WHEN a.PRODUCT = 'TL'
     THEN LEAST(a.TENURE_REQUESTED, CASE WHEN s.GRADE IN ('C1', 'C2', 'D') THEN 60 ELSE 84 END)
     ELSE 12 END TENURE_OFFER`,
    },
    related: ["working-capital", "dscr"],
  },
  "kyc": {
    id: "kyc",
    term: "KYC",
    kind: "banking",
    plain: "Know your customer, the bank's identity checks. A company whose KYC is not verified cannot get a pre-approved offer.",
    inExasol: "KYC_STATUS comes from the MySQL customer master through VS_CIF. Anything other than VERIFIED gives REFER.",
    objects: ["VS_CIF", "CREDORA.APPLICATIONS"],
    code: {
      lang: "sql",
      file: "exasol/lua/06_run_analysis.sql",
      snippet: `WHEN KYC_STATUS <> 'VERIFIED' OR GRADE IN ('C2', 'D') OR OFFER_AMT < AMOUNT_REQUESTED * 0.5`,
    },
    related: ["approve-refer-decline"],
  },
  "rm": {
    id: "rm",
    term: "RM (relationship manager)",
    kind: "banking",
    plain: "The banker who owns the relationship with a set of companies, makes the offer and negotiates.",
    inExasol: "Signs in as Exasol user CREDORA_RM (role R_RM). Sees only assigned companies through the V_RM_* views and negotiates inside the negotiation limit.",
    objects: ["CREDORA_RM", "R_RM", "CREDORA.RM_ASSIGNMENT"],
    related: ["rm-assignment", "row-level-security", "negotiation-limit"],
  },
  "loan-operations": {
    id: "loan-operations",
    term: "Loan operations",
    kind: "banking",
    plain: "The back-office team that checks the agreed terms and sanctions the loan.",
    inExasol: "Signs in as CREDORA_LOANOPS (role R_LOANOPS). Reads all of CREDORA and the bank databases, but not CREDORA_STAGE. Runs the analysis, verifies and sanctions, and assigns companies to RMs.",
    objects: ["CREDORA_LOANOPS", "R_LOANOPS"],
    related: ["maker-checker", "schema-grant", "rm-assignment"],
  },
  "disbursal": {
    id: "disbursal",
    term: "Disbursal",
    kind: "banking",
    plain: "Paying the sanctioned loan money into the customer's account. Credora tracks it as a status only and moves no money.",
    related: ["loan-status", "offer-stages"],
  },
  "top-50": {
    id: "top-50",
    term: "Top 50",
    kind: "banking",
    plain: "The 50 best pre-approved offers of a run, the ones RMs should call first.",
    inExasol: "DECISIONS.TOP50 = TRUE for the 50 best-ranked APPROVE rows after the PREFERRING skyline layers and ROW_NUMBER().",
    objects: ["CREDORA.DECISIONS"],
    related: ["preferring-skyline", "rank"],
  },
  "rank": {
    id: "rank",
    term: "Rank",
    kind: "banking",
    plain: "The order in which offers are worth pursuing, 1 being best.",
    inExasol: "DECISIONS.RANK_NO orders approved before referred before declined, then by skyline layer, PD and RAROC.",
    objects: ["CREDORA.DECISIONS"],
    related: ["top-50", "preferring-skyline"],
  },
  "pan-gstin": {
    id: "pan-gstin",
    term: "PAN and GSTIN",
    kind: "banking",
    plain: "PAN is India's tax ID for a person or company. GSTIN is the GST registration number, which contains the PAN.",
    inExasol: "CIBIL is fetched by PAN and GST by GSTIN. V_COMPANY_MASKED shows only their last characters. The V_RM_COMPANY view shows them in full for assigned companies only.",
    objects: ["CREDORA.V_COMPANY_MASKED", "CREDORA.V_RM_COMPANY"],
    related: ["masked-view", "row-level-security"],
  },
  "bounce-ratio": {
    id: "bounce-ratio",
    term: "Bounce ratio",
    kind: "banking",
    plain: "The share of the company's payments that bounced for lack of funds.",
    inExasol: "FEATURES.BOUNCE_RATIO = bounced debits / all debits over 12 months of Oracle transactions (VS_CBS). Above 8% is a hard fail.",
    objects: ["CREDORA.FEATURES", "VS_CBS"],
    related: ["hard-fail", "pushdown"],
  },
};
