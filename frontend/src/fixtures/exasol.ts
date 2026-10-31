// Fixture mode for Explain mode: a simulated Exasol console and the control room of each role.
// The statements follow the backend's real SQL (backend/app/routes/*.py); the control room follows what each
// role's Exasol user really reads on the live database (EXA_ALL_*, EXA_ROLE_*, EXA_DBA_*).

import type { ConsoleEntry, ControlRoom, CrSchema, CrScript, Section } from "../api/exasol";

type Role = "admin" | "datasci" | "loanops" | "rm";
interface U {
  username: string;
  role: Role;
}

const EXA_USER: Record<Role, string> = { admin: "CREDORA_ADMIN", datasci: "CREDORA_DATASCI", loanops: "CREDORA_LOANOPS", rm: "CREDORA_RM" };
const SVC = "CREDORA_SVC";
const RUN = "R20261031-1923";

/* ------------------------------ console ------------------------------ */

let ids = 0;
let seq = 0;
const buffers = new Map<string, ConsoleEntry[]>();

function push(u: U, session: string | null, label: string, e: Partial<ConsoleEntry> & Pick<ConsoleEntry, "kind">, at = Date.now()) {
  const list = buffers.get(u.username) ?? [];
  const last = list.slice(-6).find((x) => x.kind === "sql" && e.kind === "sql" && x.sql === e.sql && x.session === session && at - Date.parse(x.at) < 15000);
  if (last) {
    last.repeat += 1;
    last.seq = ++seq;
    last.at = new Date(at).toISOString();
    return;
  }
  list.push({
    id: ++ids,
    seq: ++seq,
    at: new Date(at).toISOString(),
    exa_user: null,
    username: u.username,
    role: u.role,
    session,
    label,
    sql: null,
    text: null,
    ms: null,
    rows: null,
    error: null,
    repeat: 1,
    via: null,
    tool: null,
    objects: [],
    ...e,
  });
  buffers.set(u.username, list.slice(-200));
}

const jitter = (base: number) => Math.round(base * (0.7 + Math.random() * 0.6) * 10) / 10;
const sql = (u: U, session: string | null, label: string, text: string, ms: number, rows: number, exa = EXA_USER[u.role], at?: number) =>
  push(u, session, label, { kind: "sql", sql: text.replace(/^\n+|\s+$/g, ""), exa_user: exa, ms: jitter(ms), rows }, at);

const LATEST = `(SELECT RUN_ID FROM CREDORA.V_LATEST_RUN)`;

/** The statements a request would make the backend run, by path. */
export function recordFixture(u: U, method: string, path: string, session: string | null) {
  if (path.startsWith("/api/exasol/") || path.startsWith("/api/jobs/")) return;
  const rm = u.role === "rm";
  const dec = rm ? "CREDORA.V_RM_DECISIONS" : "CREDORA.DECISIONS";
  const m = (re: RegExp) => re.exec(path);
  let hit: RegExpExecArray | null;
  if (method === "GET" && path === "/api/overview") {
    const L = "Overview";
    sql(u, session, L, `SELECT RUN_ID, PUBLISHED_BY, PUBLISHED_AT, NOTE FROM CREDORA.RUN_PUBLISH`, 6, 4);
    if (rm) sql(u, session, L, `SELECT COUNT(DISTINCT CIF_ID) C, COUNT(*) A, SUM(PARTNERS) P FROM CREDORA.V_RM_COMPANY WHERE RUN_ID = '${RUN}'`, 41, 1);
    else
      sql(
        u,
        session,
        L,
        `SELECT (SELECT COUNT(*) FROM VS_CIF."company") C, (SELECT COUNT(*) FROM VS_CIF."partner") P,
       (SELECT COUNT(*) FROM VS_LOS."application") A, (SELECT COUNT(*) FROM VS_CBS.ACCOUNT) ACC`,
        212,
        1,
      );
    sql(u, session, L, `SELECT DECISION, COUNT(*) N FROM ${dec} WHERE RUN_ID = '${RUN}' GROUP BY DECISION`, 9, 3);
    sql(u, session, L, `SELECT COUNT(*) FROM VS_CBS.TXN`, 388, 1, SVC);
  } else if (method === "GET" && path === "/api/companies") {
    sql(
      u,
      session,
      "Data explorer",
      rm
        ? `SELECT c.CIF_ID, c.LEGAL_NAME, c.INDUSTRY, c.CITY, c.GST_STAGE, c.PARTNERS, c.ASSIGNED_RM_ID, d.DECISION, d.RANK_NO, d.OFFER_AMOUNT,
       COUNT(*) OVER () TOTAL
FROM CREDORA.V_RM_COMPANY c LEFT JOIN CREDORA.V_RM_DECISIONS d ON d.RUN_ID = c.RUN_ID AND d.APP_ID = c.APP_ID
WHERE c.RUN_ID = '${RUN}' ORDER BY CIF_ID LIMIT 25 OFFSET 0`
        : `WITH c AS (SELECT "cif_id" CIF_ID, "legal_name" LEGAL_NAME, "industry" INDUSTRY, "city" CITY, "rm_id" RM_ID FROM VS_CIF."company"),
     p AS (SELECT "cif_id" CIF_ID, COUNT(*) PARTNERS FROM VS_CIF."partner" GROUP BY "cif_id")
SELECT c.*, p.PARTNERS, d.DECISION, d.RANK_NO, d.OFFER_AMOUNT, COUNT(*) OVER () TOTAL
FROM c LEFT JOIN p ON p.CIF_ID = c.CIF_ID
LEFT JOIN CREDORA.DECISIONS d ON d.CIF_ID = c.CIF_ID AND d.RUN_ID = ${LATEST}
ORDER BY CIF_ID LIMIT 25 OFFSET 0`,
      rm ? 18 : 164,
      25,
    );
  } else if (method === "GET" && (hit = m(/^\/api\/companies\/([^/]+)\/tree$/))) {
    const c = hit[1];
    if (rm) sql(u, session, "Company tree", `SELECT * FROM CREDORA.V_RM_COMPANY WHERE RUN_ID = '${RUN}' AND CIF_ID = '${c}'`, 14, 1);
    else {
      sql(u, session, "Company tree", `SELECT * FROM VS_CIF."company" WHERE "cif_id" = '${c}'`, 38, 1);
      sql(u, session, "Company tree", `SELECT * FROM VS_CIF."partner_profile" WHERE "cif_id" = '${c}' ORDER BY "partner_id"`, 41, 3);
      sql(u, session, "Company tree", `SELECT * FROM VS_CBS.ACCOUNT WHERE OWNER_ID IN ('${c}', 'P${c.slice(1)}01', 'P${c.slice(1)}02') ORDER BY ACCOUNT_NO`, 57, 3);
      sql(u, session, "Company tree", `SELECT * FROM VS_LOS."application" WHERE "cif_id" = '${c}' ORDER BY "app_id" DESC`, 29, 1);
    }
  } else if (method === "GET" && (hit = m(/^\/api\/nodes\/([^/]+)$/))) {
    const id = decodeURIComponent(hit[1]);
    const c = id.split(":")[0];
    if (id.includes(":txns"))
      sql(
        u,
        session,
        "Company records",
        `SELECT TXN_ID, TXN_DATE, DR_CR, AMOUNT, CHANNEL, COUNTERPARTY, NARRATION, BALANCE_AFTER, BOUNCED
FROM VS_CBS.TXN WHERE ACCOUNT_NO IN (SELECT ACCOUNT_NO FROM VS_CBS.ACCOUNT WHERE OWNER_ID = '${c}')
ORDER BY TXN_DATE DESC LIMIT 200`,
        96,
        200,
      );
    else sql(u, session, "Company records", `SELECT * FROM VS_CIF."company" WHERE "cif_id" = '${c}'`, 33, 1);
  } else if (method === "GET" && (hit = m(/^\/api\/companies\/([^/]+)\/report$/))) {
    const c = hit[1];
    const L = "Exasol report";
    sql(u, session, L, `SELECT * FROM ${dec} WHERE RUN_ID = '${RUN}' AND CIF_ID = '${c}'`, 12, 1);
    sql(u, session, L, `SELECT MODEL_VERSION, PD, GRADE, CONTRIBUTIONS FROM ${rm ? "CREDORA.V_RM_SCORES" : "CREDORA.SCORES"} WHERE RUN_ID = '${RUN}' AND APP_ID = 'A${c.slice(1)}'`, 8, 1);
    sql(u, session, L, `SELECT STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS, DETAIL FROM CREDORA.RUN_LOG WHERE RUN_ID = '${RUN}' ORDER BY STEP_NO`, 6, 13);
    sql(u, session, L, `SELECT * FROM ${rm ? "CREDORA.V_RM_FEATURES" : "CREDORA.FEATURES"} WHERE RUN_ID = '${RUN}' AND APP_ID = 'A${c.slice(1)}'`, 9, 1);
    if (!rm) sql(u, session, L, `SELECT SCORE, IS_ANOMALY, TOP_REASONS FROM CREDORA.ANOMALY WHERE RUN_ID = '${RUN}' AND APP_ID = 'A${c.slice(1)}'`, 7, 1);
  } else if (method === "GET" && path === "/api/decisions") {
    sql(
      u,
      session,
      "Decisions",
      `SELECT CIF_ID, LEGAL_NAME, DECISION, GRADE, PD, RANK_NO, OFFER_AMOUNT, OFFER_ROI, OFFER_TENURE, RAROC_OFFER,
       HARD_FAILS, ASSIGNED_RM_ID, COUNT(*) OVER () TOTAL
FROM CREDORA.DECISIONS x WHERE RUN_ID = '${RUN}'
ORDER BY RANK_NO LIMIT 50 OFFSET 0`,
      21,
      50,
    );
  } else if (method === "GET" && path === "/api/top50") {
    sql(
      u,
      session,
      "Top 50",
      `SELECT d.RANK_NO, d.CIF_ID, d.LEGAL_NAME, m.INDUSTRY, d.GRADE, d.PD, d.RAROC_OFFER, d.OFFER_AMOUNT,
       d.SKYLINE_LAYER, d.RM_ID, a.RM_ID ASSIGNED_RM_ID
FROM CREDORA.DECISIONS d
LEFT JOIN CREDORA.V_COMPANY_MASKED m ON m.RUN_ID = d.RUN_ID AND m.APP_ID = d.APP_ID
LEFT JOIN CREDORA.RM_ASSIGNMENT a ON a.CIF_ID = d.CIF_ID
WHERE d.RUN_ID = '${RUN}' AND d.TOP50 ORDER BY d.RANK_NO`,
      18,
      50,
    );
  } else if (method === "GET" && path === "/api/runs") {
    sql(u, session, "Analysis runs", `SELECT RUN_ID, STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS, LOGGED_AT FROM CREDORA.RUN_LOG ORDER BY RUN_ID, STEP_NO`, 11, 52);
  } else if (method === "GET" && path === "/api/ml/models") {
    sql(u, session, "Risk models", `SELECT MODEL_VERSION, TRAINED_AT, ALGORITHM, AUC, GINI, N_TRAIN, DEFAULT_RATE, FEATURE_IMPORTANCE, MODEL_PATH, IS_ACTIVE FROM CREDORA.MODEL_REGISTRY ORDER BY TRAINED_AT DESC`, 7, 5);
  } else if (method === "POST" && (hit = m(/^\/api\/offers\/([^/]+)\/quote$/))) {
    sql(
      u,
      session,
      "Negotiation quote",
      `WITH d AS (SELECT PD, PRODUCT, FLOOR_ROI, MAX_AMOUNT, MAX_TENURE FROM ${dec} WHERE RUN_ID = '${RUN}' AND CIF_ID = 'C000042'),
     k AS (SELECT MAX(CASE WHEN CONFIG_KEY = 'HURDLE_PCT' THEN CONFIG_VALUE END) HURDLE, MAX(CASE WHEN CONFIG_KEY = 'LGD' THEN CONFIG_VALUE END) LGD FROM CREDORA.CONFIG)
SELECT (ROI - COF - PD * LGD * 100 - OPEX) / CAPITAL_PCT * 100 RAROC, EMI, AMOUNT <= MAX_AMOUNT AND ROI >= FLOOR_ROI WITHIN_LIMIT FROM d, k`,
      14,
      1,
    );
  } else if (method === "POST" && path === "/api/whatif" || (method === "POST" && path === "/api/whatif/runs")) {
    sql(
      u,
      session,
      "What-if",
      `WITH cfg AS (SELECT 'HURDLE_PCT' K, 18.0 V FROM DUAL UNION ALL SELECT 'EBLR_PCT', 8.75 FROM DUAL),
     x AS (SELECT f.*, s.PD, s.GRADE FROM CREDORA.FEATURES f JOIN CREDORA.SCORES s ON s.RUN_ID = f.RUN_ID AND s.APP_ID = f.APP_ID WHERE f.RUN_ID = '${RUN}')
SELECT d.DECISION BEFORE_DECISION, w.DECISION AFTER_DECISION, COUNT(*) N, SUM(w.OFFER_AMOUNT) AMOUNT
FROM x /* decision SQL of RUN_ANALYSIS step 11, CONFIG replaced by cfg */ ... GROUP BY 1, 2`,
      64,
      9,
    );
  } else if (method === "POST" && path === "/api/analysis/run") {
    const L = "Run analysis";
    sql(u, session, L, `SELECT DISTINCT RUN_ID FROM CREDORA.RUN_LOG`, 5, 4, SVC);
    sql(u, session, L, `EXECUTE SCRIPT CREDORA.RUN_ANALYSIS('R20261031-2004')`, 25600, 13, SVC, Date.now() + 100);
    const names = [
      "Refresh virtual schemas",
      "Read credit needs on file",
      "Fetch CIBIL consumer reports (API)",
      "Fetch CIBIL commercial reports (API)",
      "Fetch GST returns (API)",
      "Fetch partner accounts at other banks (Account Aggregator API)",
      "Compute features",
      "Risk model",
      "Score probability of default (ML UDF)",
      "Flag anomalies (Isolation Forest UDF)",
      "Decide offer and negotiation limit",
      "Rank with PREFERRING skyline",
      "Shadow-score with the challenger model",
    ];
    const msS = [1838, 316, 927, 582, 1730, 3538, 10776, 2, 1912, 1304, 70, 23, 1701];
    const rows = [3, 1000, 3492, 1000, 71665, 5775, 1000, 1, 1000, 1000, 1000, 63, 1000];
    let t = 0;
    names.forEach((n, i) => {
      t += msS[i] / 9;
      window.setTimeout(() => {
        sql(u, session, L, `SELECT STEP_NO, STATUS, ROWS_OUT, MS, DETAIL FROM CREDORA.RUN_LOG WHERE RUN_ID = 'R20261031-2004'`, 3, i + 1, SVC);
        push(u, session, L, {
          kind: "step",
          exa_user: SVC,
          text: `RUN_ANALYSIS step ${i + 1}/13 ${n} committed in ${(msS[i] / 1000).toFixed(1)} s`,
          ms: msS[i],
          rows: rows[i],
          objects: ["CREDORA.RUN_LOG"],
        });
        if (i === 8)
          push(u, session, L, { kind: "event", exa_user: SVC, text: "PD_SCORE loaded model v3 pickle from BucketFS (/buckets/bfsdefault/default/models/pd_v3.pkl), 4 instances", objects: ["CREDORA.PD_SCORE"] });
      }, t);
    });
  } else if (method === "POST" && (hit = m(/^\/api\/runs\/([^/]+)\/publish$/))) {
    sql(
      u,
      session,
      "Publish run",
      `INSERT INTO CREDORA.RUN_PUBLISH (RUN_ID, PUBLISHED_BY, PUBLISHED_AT, NOTE)
SELECT '${hit[1]}', '${u.username}', SYSTIMESTAMP, 'Reviewed' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM CREDORA.RUN_PUBLISH WHERE RUN_ID = '${hit[1]}')`,
      11,
      1,
      SVC,
    );
    push(u, session, "Publish run", {
      kind: "event",
      exa_user: SVC,
      text: `CREDORA.RUN_PUBLISH has ${hit[1]}. V_LATEST_RUN, the V_LATEST_* views, CREDORA_SEM.PORTFOLIO and the V_RM_* views now read this run`,
    });
  } else if (method === "POST" && path === "/api/ml/train") {
    const L = "Train models";
    sql(u, session, L, `SELECT MODEL_VERSION FROM CREDORA.MODEL_REGISTRY WHERE IS_ACTIVE`, 4, 1, SVC);
    sql(u, session, L, `EXECUTE SCRIPT CREDORA.TRAIN_MODEL('v4')`, 6200, 2, SVC);
    sql(u, session, L, `UPDATE CREDORA.MODEL_REGISTRY SET IS_ACTIVE = (MODEL_VERSION = 'v3')`, 9, 7, SVC);
    push(u, session, L, { kind: "step", exa_user: SVC, text: "TRAIN_PD pickled v4 to BucketFS /buckets/bfsdefault/default/models/pd_v4.pkl (AUC 0.763) and registered it in MODEL_REGISTRY" });
    push(u, session, L, { kind: "event", exa_user: SVC, text: "MODEL_REGISTRY.IS_ACTIVE kept on v3. v4 waits for the admin's activation approval" });
    sql(u, session, L, `EXECUTE SCRIPT CREDORA.SCORE_CHALLENGER('${RUN}')`, 1700, 1000, SVC);
  } else if (method === "POST" && (hit = m(/^\/api\/ml\/activation-requests\/[^/]+\/approve$/))) {
    sql(u, session, "Model activation", `UPDATE CREDORA.MODEL_REGISTRY SET IS_ACTIVE = (MODEL_VERSION = 'v3-lr')`, 8, 7, SVC);
    push(u, session, "Model activation", { kind: "event", exa_user: SVC, text: "MODEL_REGISTRY.IS_ACTIVE switched to v3-lr. The next RUN_ANALYSIS scores with it (PD_SCORE loads its pickle from BucketFS)" });
  } else if (method === "POST" && path === "/api/assignments") {
    sql(
      u,
      session,
      "RM assignment",
      `MERGE INTO CREDORA.RM_ASSIGNMENT t USING (SELECT 'C000042' CIF_ID, 'RM001' RM_ID, 'CREDORA_RM' EXA_USER, 'loanops' ASSIGNED_BY FROM DUAL) s
ON t.CIF_ID = s.CIF_ID
WHEN MATCHED THEN UPDATE SET RM_ID = s.RM_ID, EXA_USER = s.EXA_USER, ASSIGNED_BY = s.ASSIGNED_BY, ASSIGNED_AT = SYSTIMESTAMP
WHEN NOT MATCHED THEN INSERT VALUES (s.CIF_ID, s.RM_ID, s.EXA_USER, s.ASSIGNED_BY, SYSTIMESTAMP)`,
      16,
      1,
      SVC,
    );
  } else if (method === "POST" && (hit = m(/^\/api\/loan-status\/([^/]+)$/))) {
    sql(
      u,
      session,
      "Loan status",
      `INSERT INTO CREDORA.LOAN_STATUS_LOG (CIF_ID, RM_ID, STATUS, NOTE, LOGGED_BY, LOGGED_AT) VALUES ('${hit[1]}', 'RM001', 'CONTACTED', 'Called the CFO', 'rm', SYSTIMESTAMP)`,
      9,
      1,
      SVC,
    );
  } else if (method === "POST" && (hit = m(/^\/api\/companies\/([^/]+)\/memo$/))) {
    sql(u, session, "Credit memo", `SELECT CONNECTION_NAME FROM EXA_ALL_CONNECTIONS WHERE CONNECTION_NAME = 'AI_LLM'`, 4, 1, SVC);
    sql(u, session, "Credit memo", `SELECT CREDORA.CREDIT_MEMO('AI_LLM', 'claude-sonnet-5-5', '${hit[1]}', '{"decision":"APPROVE","grade":"A2","pd":0.021, ...}')`, 7400, 1, SVC);
  } else if (method === "POST" && path === "/api/ai/ask") {
    const via = `Claude → exasol-mcp-server (EC2 app host) → Exasol as ${EXA_USER[u.role]}`;
    push(u, session, "Ask Credora", {
      kind: "mcp",
      exa_user: EXA_USER[u.role],
      tool: "execute_exasol_query",
      via,
      ms: jitter(420),
      sql: `SELECT industry, approved_companies, pre_approved_amount FROM CREDORA_SEM.PORTFOLIO GROUP BY industry ORDER BY pre_approved_amount DESC LIMIT 5`,
    });
    if (!rm)
      push(u, session, "Ask Credora", {
        kind: "mcp",
        exa_user: EXA_USER[u.role],
        tool: "execute_exasol_query",
        via,
        ms: jitter(180),
        sql: `SELECT COUNT(*) FROM CREDORA.DECISIONS WHERE RUN_ID = '${RUN}' AND HARD_FAILS LIKE '%GST%'`,
      });
  } else if (method === "POST" && path === "/api/admin/generate") {
    push(u, session, "Generate data", {
      kind: "event",
      text: "Generator (replace) rewrites the RDS source databases. Nothing is loaded into Exasol. VS_CBS, VS_CIF and VS_LOS read the new rows in place, and the next RUN_ANALYSIS refreshes them first",
    });
  } else if (method === "GET" && path === "/api/admin/sources") {
    sql(u, session, "Sources", `SELECT COUNT(*) FROM VS_CBS.TXN`, 388, 1, SVC);
    sql(u, session, "Sources", `SELECT COUNT(*) FROM VS_CIF."company"`, 31, 1, SVC);
    sql(u, session, "Sources", `SELECT COUNT(*) FROM VS_LOS."application"`, 27, 1, SVC);
  } else if (method === "GET" && path === "/api/loan-status") {
    const L = "Loan status";
    if (rm) {
      sql(u, session, L, `SELECT CIF_ID, RM_ID, ASSIGNED_BY, ASSIGNED_AT FROM CREDORA.V_RM_ASSIGNMENT`, 9, 6);
      sql(u, session, L, `SELECT CIF_ID, LEGAL_NAME, DECISION, RANK_NO, OFFER_AMOUNT FROM CREDORA.V_RM_DECISIONS WHERE RUN_ID = '${RUN}'`, 11, 6);
      sql(u, session, L, `SELECT EVENT_ID, CIF_ID, RM_ID, STATUS, NOTE, LOGGED_BY, LOGGED_AT FROM CREDORA.V_RM_LOAN_STATUS ORDER BY LOGGED_AT`, 8, 14);
    } else {
      sql(
        u,
        session,
        L,
        `SELECT a.CIF_ID, a.RM_ID, a.ASSIGNED_BY, a.ASSIGNED_AT, d.LEGAL_NAME, d.DECISION, d.RANK_NO, d.OFFER_AMOUNT
FROM CREDORA.RM_ASSIGNMENT a LEFT JOIN CREDORA.DECISIONS d ON d.CIF_ID = a.CIF_ID AND d.RUN_ID = '${RUN}'`,
        14,
        42,
      );
      sql(u, session, L, `SELECT EVENT_ID, CIF_ID, RM_ID, STATUS, NOTE, LOGGED_BY, LOGGED_AT FROM CREDORA.LOAN_STATUS_LOG ORDER BY LOGGED_AT`, 9, 96);
    }
  } else if (method === "GET" && path === "/api/rms") {
    sql(u, session, "Relationship managers", `SELECT "rm_id", "name", "branch" FROM VS_CIF."rm" ORDER BY "rm_id"`, 29, 12);
  } else if (method === "GET" && path === "/api/ml/compare") {
    sql(
      u,
      session,
      "Champion vs challenger",
      `SELECT s.GRADE CHAMPION_GRADE, c.GRADE CHALLENGER_GRADE, d.DECISION, c.DECISION CHALLENGER_DECISION, COUNT(*) N
FROM CREDORA.CHALLENGER_SCORES c JOIN CREDORA.SCORES s ON s.RUN_ID = c.RUN_ID AND s.APP_ID = c.APP_ID
JOIN CREDORA.DECISIONS d ON d.RUN_ID = c.RUN_ID AND d.APP_ID = c.APP_ID WHERE c.RUN_ID = '${RUN}' GROUP BY 1, 2, 3, 4`,
      22,
      31,
    );
  } else if (method === "GET" && path === "/api/admin/purge-log") {
    sql(u, session, "Purge", `SELECT PURGED_AT, TABLE_NAME, RUN_ID, ROWS_DELETED, SHA256 FROM CREDORA.PURGE_LOG ORDER BY PURGED_AT DESC LIMIT 500`, 6, 24);
  }
}

/* ------------------------------ control room ------------------------------ */

const ok = <T,>(data: T, ms = 30): Section<T> => ({ ok: true, data, ms });
const denied = (what: string, ms = 30): Section<never> => ({ ok: false, denied: true, error: `insufficient privileges: SELECT on table ${what}`, ms });

const COMMENTS: Record<string, string> = {
  CREDORA:
    "Credora results inside Exasol. The analysis of Sapphire Bank's corporate customers (decisions, features, scores, models, run log, policy), the hand-off to relationship managers, and the purge proof.",
  CREDORA_SEM: "Published semantic model credora, Sapphire Bank corporate lending. Credora's pre-approved offer portfolio from the latest completed analysis run.",
  CREDORA_STAGE: "Raw replies from the 3rd party APIs (CIBIL, GSTN, Account Aggregator) and core-banking monthly aggregates, staged by RUN_ANALYSIS.",
  PREPROC: "preprocessor-framework v0.9.1",
  SCHED: "exasol-labs/exasol-scheduler, which runs Credora's scheduled jobs.",
  SEMANTIC_ADMIN: "Lua admin, compiler, validation, publish, preprocessor and agent scripts.",
  SYS_SEMANTIC: "Internal catalog tables for Exasol Semantic Views.",
};

function schemas(role: Role): CrSchema[] {
  const full = role !== "rm";
  const semantic: Record<string, Record<string, number>> = {
    SEMANTIC_ADMIN: { script: 103 },
    SEMANTIC_AGENT: { view: 18, table: 1 },
    SEMANTIC_CATALOG: { view: 52, table: 1 },
    SEMANTIC_SOURCE: { view: 44 },
    SYS_SEMANTIC: { table: 3 },
  };
  const counts: Record<string, Record<string, number>> = {
    ADAPTER: {},
    ADBC_VS: {},
    CREDORA: role === "rm" ? { view: 11, table: 3 } : { view: 13, script: 14, table: 14 },
    CREDORA_SEM: { view: 1, table: 1 },
    CREDORA_STAGE: role === "admin" || role === "datasci" ? { table: 5 } : {},
    PREPROC: {},
    PREPROC_RT: { view: 2, script: 10 },
    SCHED: role === "admin" || role === "datasci" ? { table: 2 } : {},
    ...semantic,
    VS_CBS: full ? { table: 2 } : {},
    VS_CIF: full ? { table: 4 } : {},
    VS_LOS: full ? { table: 3 } : {},
  };
  return Object.keys(counts)
    .sort()
    .map((name) => ({
      name,
      owner: name.startsWith("PREPROC") ? "PREPROC_ADMIN" : "SYS",
      virtual: name.startsWith("VS_"),
      comment: COMMENTS[name] ?? null,
      counts: counts[name],
      visible: Object.values(counts[name]).reduce((a, b) => a + b, 0),
    }));
}

const CREDORA_SCRIPTS: [string, string, string, string | null, string][] = [
  ["AA_FETCH", "UDF", "PYTHON3", "SET", "EMITS"],
  ["ANOMALY_FLAG", "UDF", "PYTHON3", "SET", "EMITS"],
  ["CIBIL_COMMERCIAL_FETCH", "UDF", "PYTHON3", "SET", "EMITS"],
  ["CIBIL_CONSUMER_FETCH", "UDF", "PYTHON3", "SET", "EMITS"],
  ["CREDIT_MEMO", "UDF", "PYTHON3", "SCALAR", "EMITS"],
  ["DECISION_LOGIC", "SCRIPTING", "LUA", null, "ROWCOUNT"],
  ["GST_FETCH", "UDF", "PYTHON3", "SET", "EMITS"],
  ["PD_SCORE", "UDF", "PYTHON3", "SET", "EMITS"],
  ["PURGE_EXPIRED", "SCRIPTING", "LUA", null, "TABLE"],
  ["RUN_ANALYSIS", "SCRIPTING", "LUA", null, "TABLE"],
  ["SCORE_CHALLENGER", "SCRIPTING", "LUA", null, "ROWCOUNT"],
  ["TRAIN_MODEL", "SCRIPTING", "LUA", null, "ROWCOUNT"],
  ["TRAIN_PD", "UDF", "PYTHON3", "SET", "EMITS"],
  ["TRAIN_SCORECARD", "UDF", "PYTHON3", "SET", "EMITS"],
];
const PREPROC_SCRIPTS: [string, string, string, string | null, string][] = [
  ["CAST_SHORTHAND_V1", "SCRIPTING", "LUA", null, "ROWCOUNT"],
  ["CONTROL_SUGAR_V1", "SCRIPTING", "LUA", null, "ROWCOUNT"],
  ["ERGONOMICS_TRAILING_COMMA_V2", "SCRIPTING", "LUA", null, "ROWCOUNT"],
  ["MASTER", "SCRIPTING", "LUA", null, "ROWCOUNT"],
  ["SEMANTIC_VIEWS_REFUSE_V1", "UDF", "LUA", "SCALAR", "RETURNS"],
  ["SEMANTIC_VIEWS_V1", "SCRIPTING", "LUA", null, "ROWCOUNT"],
];

function scripts(role: Role) {
  const toItems = (schema: string, rows: typeof CREDORA_SCRIPTS): CrScript[] =>
    rows.map(([name, type, language, input, result]) => ({ schema, name, type, language, input, result, comment: null }));
  const items = [...(role === "rm" ? [] : toItems("CREDORA", CREDORA_SCRIPTS)), ...toItems("PREPROC_RT", PREPROC_SCRIPTS)];
  const per: Record<string, number> = { PREPROC_RT: 10, SEMANTIC_ADMIN: 103 };
  if (role !== "rm") per.CREDORA = 14;
  return { items, per_schema: per, total: Object.values(per).reduce((a, b) => a + b, 0) };
}

const OBJ = (privilege: string, type: string, object: string) => ({ privilege, type, object });
const ROLE_GRANTS: Record<string, { users: string[]; system: string[]; objects: ReturnType<typeof OBJ>[] }> = {
  R_SVC: {
    users: ["CREDORA_SVC"],
    system: ["CREATE TABLE", "DROP ANY TABLE", "CREATE SESSION", "ALTER ANY VIRTUAL SCHEMA REFRESH"],
    objects: [
      ...["SELECT", "INSERT", "UPDATE", "DELETE"].map((p) => OBJ(p, "SCHEMA", "CREDORA_STAGE")),
      ...["SELECT", "INSERT", "UPDATE", "DELETE", "EXECUTE"].map((p) => OBJ(p, "SCHEMA", "CREDORA")),
      OBJ("SELECT", "SCHEMA", "VS_CBS"),
      OBJ("SELECT", "SCHEMA", "VS_CIF"),
      OBJ("SELECT", "SCHEMA", "VS_LOS"),
      OBJ("SELECT", "TABLE", "SCHED.SCHED_TASKS"),
      OBJ("INSERT", "TABLE", "SCHED.SCHED_HISTORY"),
    ],
  },
  R_ADMIN: {
    users: ["CREDORA_ADMIN"],
    system: ["CREATE SESSION", "SELECT ANY DICTIONARY"],
    objects: ["CREDORA_STAGE", "CREDORA", "VS_CBS", "VS_CIF", "VS_LOS", "CREDORA_SEM"].map((s) => OBJ("SELECT", "SCHEMA", s)),
  },
  R_DATASCI: {
    users: ["CREDORA_DATASCI"],
    system: ["CREATE SESSION"],
    objects: ["CREDORA_STAGE", "CREDORA", "VS_CBS", "VS_CIF", "VS_LOS", "CREDORA_SEM"].map((s) => OBJ("SELECT", "SCHEMA", s)),
  },
  R_LOANOPS: {
    users: ["CREDORA_LOANOPS"],
    system: ["CREATE SESSION"],
    objects: ["CREDORA", "VS_CBS", "VS_CIF", "VS_LOS", "CREDORA_SEM"].map((s) => OBJ("SELECT", "SCHEMA", s)),
  },
  R_RM: {
    users: ["CREDORA_RM"],
    system: ["CREATE SESSION"],
    objects: [
      OBJ("SELECT", "SCHEMA", "CREDORA_SEM"),
      ...["CONFIG", "RUN_LOG", "RUN_PUBLISH"].map((t) => OBJ("SELECT", "TABLE", `CREDORA.${t}`)),
      ...["V_LATEST_RUN", "V_LATEST_COMPANY", "V_LATEST_DECISION", "V_LATEST_SCORE", "V_LATEST_FEATURE", "V_RM_ASSIGNMENT", "V_RM_DECISIONS", "V_RM_COMPANY", "V_RM_FEATURES", "V_RM_SCORES", "V_RM_LOAN_STATUS"].map((v) =>
        OBJ("SELECT", "VIEW", `CREDORA.${v}`),
      ),
    ],
  },
  R_MCP: {
    users: ["CREDORA_MCP"],
    system: ["CREATE SESSION"],
    objects: ["DECISIONS", "SCORES", "FEATURES", "RUN_LOG", "MODEL_REGISTRY", "CHALLENGER_SCORES", "ANOMALY", "CONFIG", "V_COMPANY_MASKED"].map((t) =>
      OBJ("SELECT", t.startsWith("V_") ? "VIEW" : "TABLE", `CREDORA.${t}`),
    ),
  },
};

const METRICS: [string, string, string, string | null][] = [
  ["companies_analysed", "Companies analysed", "SUM(company_count)", null],
  ["approved_companies", "Pre-approved companies", "SUM(company_count)", "de.DECISION = 'APPROVE'"],
  ["referred_companies", "Referred companies", "SUM(company_count)", "de.DECISION = 'REFER'"],
  ["declined_companies", "Declined companies", "SUM(company_count)", "de.DECISION = 'DECLINE'"],
  ["approval_rate", "Approval rate", "approved_companies / companies_analysed", null],
  ["pre_approved_amount", "Pre-approved amount", "SUM(offer_amount)", "de.DECISION = 'APPROVE'"],
  ["offered_amount", "Offered amount", "SUM(offer_amount)", "de.DECISION IN ('APPROVE', 'REFER')"],
  ["negotiation_headroom", "Negotiation headroom", "SUM(max_amount - offer_amount)", null],
  ["avg_offer_roi", "Average offer ROI", "offer_roi_total / offered_companies", null],
  ["avg_raroc_offer", "Average RAROC at offer", "raroc_offer_total / offered_companies", null],
  ["avg_pd", "Average PD", "pd_total / companies_analysed", null],
  ["expected_loss", "Expected loss", "SUM(pd * 0.45 * offer_amount)", null],
  ["top50_amount", "Top 50 amount", "SUM(offer_amount)", "de.TOP50"],
  ["anomaly_flagged_companies", "Anomaly-flagged companies", "SUM(company_count)", "an.IS_ANOMALY"],
];

const RUN_STEPS: [string, number, number][] = [
  ["Refresh virtual schemas", 3, 1838],
  ["Read credit needs on file", 1000, 316],
  ["Fetch CIBIL consumer reports (API)", 3492, 927],
  ["Fetch CIBIL commercial reports (API)", 1000, 582],
  ["Fetch GST returns (API)", 71665, 1730],
  ["Fetch partner accounts at other banks (Account Aggregator API)", 5775, 3538],
  ["Compute features", 1000, 10776],
  ["Risk model", 1, 2],
  ["Score probability of default (ML UDF)", 1000, 1912],
  ["Flag anomalies (Isolation Forest UDF)", 1000, 1304],
  ["Decide offer and negotiation limit", 1000, 70],
  ["Rank with PREFERRING skyline", 63, 23],
  ["Shadow-score with the challenger model", 1000, 1701],
];

export function controlRoomFixture(role: Role): ControlRoom {
  const user = EXA_USER[role];
  const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
  const roles =
    role === "admin"
      ? Object.entries(ROLE_GRANTS).map(([r, g]) => ({ role: r, ...g }))
      : [{ role: `R_${role.toUpperCase()}`, ...ROLE_GRANTS[`R_${role.toUpperCase()}`] }];
  return {
    role,
    exasol_user: user,
    read_at: new Date().toISOString(),
    took_ms: 286,
    cached: false,
    system: ok({
      version: "2026.1.0",
      current_user: user,
      session_id: "18805773" + String(Math.floor(Math.random() * 1e11)).padStart(11, "0"),
      instance_type: "r6i.xlarge",
      deployment: "Exasol Personal on AWS EC2 (launcher 2.3.0)",
      nodes: 1,
      vcpu: 4,
      db_ram_gib: 23.5,
    }),
    schemas: ok(schemas(role), 41),
    virtual_schemas: ok(
      [
        { name: "VS_CBS", adapter: "ADAPTER.ORACLE_ADAPTER", driver: null, driver_version: null, source: "Oracle (RDS)", database: "SAPPHIRE, schema CBS", holds: "Core banking accounts and transactions", connection: "ORA_CBS", extension: "oracle-virtual-schema" },
        { name: "VS_CIF", adapter: "ADBC_VS.ADBC_ADAPTER", driver: "mysql", driver_version: "0.6.1", source: "MySQL (RDS)", database: "cif", holds: "Customer master with companies, partners and RMs", connection: "MYSQL_CIF", extension: "adbc-vs-rs" },
        { name: "VS_LOS", adapter: "ADBC_VS.ADBC_ADAPTER", driver: "postgresql", driver_version: "1.13.0", source: "PostgreSQL (RDS)", database: "los", holds: "Loan origination with credit need on file and past loans", connection: "PG_LOS", extension: "adbc-vs-rs" },
      ].map((v) => ({ ...v, last_refresh: minsAgo(38), last_refresh_by: "CREDORA_SVC" })),
      12,
    ),
    scripts: ok(scripts(role), 22),
    connections: ok(["ADBC_VS_BUCKETFS", "AI_LLM", "BUCKETFS_MODELS", "MOCK_AA", "MOCK_CIBIL", "MOCK_GSTN", "MYSQL_CIF", "ORA_CBS", "PG_LOS"].map((name) => ({ name, created: minsAgo(400) })), 9),
    models:
      role === "rm"
        ? denied("MODEL_REGISTRY", 8)
        : ok(
            [
              ["v3-lr", "LogisticRegression scorecard", 0.7692, false],
              ["v3", "GradientBoostingClassifier", 0.7561, true],
              ["v2-lr", "LogisticRegression scorecard", 0.7692, false],
              ["v2", "GradientBoostingClassifier", 0.7561, false],
              ["v1", "GradientBoostingClassifier", 0.7447, false],
            ].map(([v, alg, auc, active], i) => ({
              version: v as string,
              algorithm: alg as string,
              trained_at: minsAgo(60 + i * 30),
              auc: auc as number,
              gini: Math.round(((auc as number) * 2 - 1) * 1000) / 1000,
              train_rows: 4000,
              path: `/buckets/bfsdefault/default/models/pd_${v}.pkl`,
              active: active as boolean,
            })),
            7,
          ),
    security: ok({ scope: role === "admin" ? "dba" : "own", roles, users: role === "admin" ? ["CREDORA_ADMIN", "CREDORA_DATASCI", "CREDORA_LOANOPS", "CREDORA_MCP", "CREDORA_RM", "CREDORA_SVC", "SYS"] : [] }, 35),
    preprocessor: ok(
      {
        system: "PREPROC_RT.MASTER",
        session: "PREPROC_RT.P_0B7ABE74246AC9EBBAA7E30A7DCF38F4",
        languages: [
          { alias: "R", builtin: true, container: "builtin_r" },
          { alias: "JAVA", builtin: true, container: "builtin_java" },
          { alias: "PYTHON3", builtin: true, container: "builtin_python3" },
          { alias: "RUST", builtin: false, container: "localzmq+protobuf:///bfsdefault/default/slc/rustslc" },
        ],
      },
      6,
    ),
    semantic: ok(
      {
        version: "0.5.1",
        models: [{ name: "credora", schema: "CREDORA_SEM", status: "PUBLISHED", surface: "VIEW_PREPROCESSOR", model_version: 1, description: null }],
        metrics: METRICS.map(([name, display, expression, filter]) => ({ name, display, description: null, expression, filter, kind: filter ? "FILTERED" : "SIMPLE", certified: true })),
      },
      48,
    ),
    run_log: ok({ run_id: RUN, steps: RUN_STEPS.map(([name, rows, ms], i) => ({ n: i + 1, name, status: "OK", rows, ms, at: minsAgo(38) })) }, 9),
    sessions:
      role === "admin"
        ? ok(
            [
              ["CREDORA_ADMIN", "EXECUTE SQL", "SELECT", "credora:admin:web", "CREDORA_APP", "0:00:00"],
              ["CREDORA_SVC", "IDLE", "NOT SPECIFIED", "credora:system:web", "CREDORA_BATCH", "0:00:02"],
              ["CREDORA_DATASCI", "IDLE", "NOT SPECIFIED", "credora:datasci:web", "CREDORA_APP", "0:04:51"],
              ["CREDORA_LOANOPS", "IDLE", "NOT SPECIFIED", "credora:loanops:web", "CREDORA_APP", "0:12:29"],
              ["CREDORA_RM", "IDLE", "NOT SPECIFIED", "credora:rm:web", "CREDORA_APP", "0:21:03"],
              ["CREDORA_RM", "IDLE", "NOT SPECIFIED", "exasol-mcp-server", "CREDORA_APP", "0:00:41"],
            ].map(([user, status, command, client, group, duration], i) => ({
              session_id: `${1880577361 - i * 3}861607424`,
              user,
              status,
              command,
              duration,
              login_time: minsAgo(i * 4),
              client: `${client} 1`,
              driver: "PyExasol 1.3.0",
              consumer_group: group,
            })),
            11,
          )
        : null,
  };
}

/** Answers /api/exasol/*; undefined for any other path. */
export function exasolFixture(u: U, path: string, q: URLSearchParams, session: string | null): { status: number; body: unknown } | undefined {
  if (path === "/api/exasol/control-room") {
    recordControlRoom(u, session);
    return { status: 200, body: controlRoomFixture(u.role) };
  }
  if (path === "/api/exasol/console") {
    const since = Number(q.get("since") ?? 0) || 0;
    const scope = (q.get("scope") ?? "session") as "session" | "user" | "all";
    if (scope === "all" && u.role !== "admin") return { status: 403, body: { detail: "Only the admin may see every user's Exasol statements." } };
    const pool =
      scope === "all"
        ? Array.from(buffers.values()).flat()
        : (buffers.get(u.username) ?? []).filter((e) => scope === "user" || !session || e.session === session);
    const entries = pool.filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq).slice(-200);
    return { status: 200, body: { entries, last: Math.max(since, ...entries.map((e) => e.seq)), scope, exasol_user: EXA_USER[u.role] } };
  }
  return undefined;
}

function recordControlRoom(u: U, session: string | null) {
  const L = "Exasol control room";
  const s = (t: string, ms: number, rows: number) => sql(u, session, L, t, ms, rows);
  s("SELECT CURRENT_USER U, CURRENT_SESSION S FROM DUAL", 2, 1);
  s("SELECT PARAM_VALUE FROM EXA_METADATA WHERE PARAM_NAME = 'databaseProductVersion'", 3, 1);
  s("SELECT SCHEMA_NAME, SCHEMA_OWNER, SCHEMA_IS_VIRTUAL, SCHEMA_COMMENT FROM EXA_ALL_SCHEMAS ORDER BY SCHEMA_NAME", 6, 16);
  s("SELECT ROOT_NAME, OBJECT_TYPE, COUNT(*) N FROM EXA_ALL_OBJECTS WHERE ROOT_TYPE = 'SCHEMA' GROUP BY ROOT_NAME, OBJECT_TYPE", 31, u.role === "rm" ? 13 : 18);
  s("SELECT SCHEMA_NAME, ADAPTER_SCRIPT_SCHEMA, ADAPTER_SCRIPT_NAME, LAST_REFRESH, LAST_REFRESH_BY, ADAPTER_NOTES FROM EXA_ALL_VIRTUAL_SCHEMAS ORDER BY SCHEMA_NAME", 4, 3);
  s("SELECT SCRIPT_SCHEMA, SCRIPT_NAME, SCRIPT_TYPE, SCRIPT_LANGUAGE, SCRIPT_INPUT_TYPE, SCRIPT_RESULT_TYPE, SCRIPT_COMMENT FROM EXA_ALL_SCRIPTS ORDER BY SCRIPT_SCHEMA, SCRIPT_NAME", 18, u.role === "rm" ? 113 : 127);
  s("SELECT CONNECTION_NAME, CREATED FROM EXA_ALL_CONNECTIONS ORDER BY CONNECTION_NAME", 3, 9);
  if (u.role === "rm")
    push(u, session, L, {
      kind: "sql",
      exa_user: EXA_USER.rm,
      sql: "SELECT MODEL_VERSION, ALGORITHM, TRAINED_AT, AUC, GINI, N_TRAIN, MODEL_PATH, IS_ACTIVE FROM CREDORA.MODEL_REGISTRY ORDER BY TRAINED_AT DESC",
      ms: 4,
      error: "insufficient privileges: SELECT on table MODEL_REGISTRY",
    });
  else s("SELECT MODEL_VERSION, ALGORITHM, TRAINED_AT, AUC, GINI, N_TRAIN, MODEL_PATH, IS_ACTIVE FROM CREDORA.MODEL_REGISTRY ORDER BY TRAINED_AT DESC", 5, 5);
  if (u.role === "admin") {
    s("SELECT GRANTEE, GRANTED_ROLE FROM EXA_DBA_ROLE_PRIVS WHERE GRANTED_ROLE IN ('R_SVC', 'R_ADMIN', 'R_DATASCI', 'R_LOANOPS', 'R_RM', 'R_MCP')", 4, 6);
    s("SELECT GRANTEE, PRIVILEGE, OBJECT_TYPE, OBJECT_SCHEMA, OBJECT_NAME FROM EXA_DBA_OBJ_PRIVS WHERE GRANTEE IN ('R_SVC', 'R_ADMIN', 'R_DATASCI', 'R_LOANOPS', 'R_RM', 'R_MCP')", 9, 74);
    s("SELECT SESSION_ID, USER_NAME, STATUS, COMMAND_NAME, DURATION, LOGIN_TIME, CLIENT, DRIVER, CONSUMER_GROUP FROM EXA_DBA_SESSIONS ORDER BY LOGIN_TIME DESC LIMIT 40", 7, 6);
  } else {
    s("SELECT GRANTEE, GRANTED_ROLE FROM EXA_USER_ROLE_PRIVS", 3, 1);
    s("SELECT GRANTEE, PRIVILEGE, OBJECT_TYPE, OBJECT_SCHEMA, OBJECT_NAME FROM EXA_ROLE_OBJ_PRIVS WHERE GRANTEE LIKE 'R%'", 6, u.role === "rm" ? 17 : 6);
  }
  s("SELECT PARAMETER_NAME, SESSION_VALUE, SYSTEM_VALUE FROM EXA_PARAMETERS WHERE PARAMETER_NAME IN ('SQL_PREPROCESSOR_SCRIPT', 'SCRIPT_LANGUAGES')", 3, 2);
  s("SELECT METRIC_NAME, DISPLAY_NAME, DESCRIPTION, EXPRESSION, FILTER_EXPR, METRIC_KIND, IS_CERTIFIED FROM SEMANTIC_CATALOG.METRICS WHERE MODEL_NAME = 'credora' ORDER BY METRIC_ID", 44, 20);
  s(
    "SELECT RUN_ID, STEP_NO, STEP_NAME, STATUS, ROWS_OUT, MS, LOGGED_AT FROM CREDORA.RUN_LOG\nWHERE RUN_ID = (SELECT RUN_ID FROM CREDORA.RUN_LOG GROUP BY RUN_ID ORDER BY MAX(LOGGED_AT) DESC LIMIT 1)\nORDER BY STEP_NO",
    5,
    13,
  );
}
