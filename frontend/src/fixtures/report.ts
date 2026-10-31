import type { Feature, Reason, Report, ReportStep, SourceId } from "../api/types";
import { type Company, type Scored, type World } from "./world";

const L = (s: string) => s.replace(/^\n/, "").replace(/\s+$/, "");

export function buildSteps(c: Company, s: Scored, partners: number, runId: string): ReportStep[] {
  const steps: Omit<ReportStep, "n">[] = [
    {
      name: "Read Sapphire Bank data in place",
      what: "Exasol reads the company, its partners, accounts, transactions and the credit need on file straight from the bank's three databases through virtual schemas. Filters are pushed down, so only this company's rows travel.",
      engine: "SQL · virtual schema",
      object: "VS_CBS, VS_CIF, VS_LOS",
      language: "sql",
      sources: ["bank.oracle", "bank.mysql", "bank.postgres"],
      ms: 412,
      code: L(`
-- Three adapters, one SQL dialect: Oracle (core banking), MySQL (customer master), PostgreSQL (loans)
SELECT c.CIF_ID, c.LEGAL_NAME, c.PAN, c.GSTIN, c.CONSTITUTION, c.RM_ID,
       a.ACCOUNT_NO, a.ACCT_TYPE, a.OPENED_ON,
       l.APP_ID, l.PRODUCT, l.AMOUNT_REQUESTED, l.TENURE_REQUESTED, l.COLLATERAL_VALUE
FROM   VS_CIF.COMPANY      c                                   -- MySQL  cif.company
JOIN   VS_CBS.ACCOUNT      a ON a.OWNER_ID = c.CIF_ID          -- Oracle CBS.ACCOUNT
                            AND a.OWNER_TYPE = 'COMPANY'
JOIN   VS_LOS.APPLICATION  l ON l.CIF_ID = c.CIF_ID            -- PostgreSQL los.application
WHERE  c.CIF_ID = '${c.cif_id}';`),
    },
    {
      name: "Fetch CIBIL, GST and Account Aggregator data",
      what: "Python UDFs call the three mock 3rd party APIs on demand, in parallel across Exasol's nodes, with one row in and many rows out. Raw replies land in CREDORA_STAGE with a purge time.",
      engine: "Python UDF",
      object: "CIBIL_FETCH, GST_FETCH, AA_FETCH",
      language: "sql",
      sources: ["api.cibil", "api.gstn", "api.aa"],
      ms: 1380,
      code: L(`
INSERT INTO CREDORA_STAGE.GST_RAW
SELECT CREDORA.GST_FETCH(c.GSTIN, '${runId}')
FROM   VS_CIF.COMPANY c WHERE c.CIF_ID = '${c.cif_id}';

INSERT INTO CREDORA_STAGE.CIBIL_RAW            -- company (commercial) + ${partners} partners (consumer)
SELECT CREDORA.CIBIL_FETCH(p.PAN, p.KIND, '${runId}')
FROM  (SELECT PAN, 'commercial' AS KIND FROM VS_CIF.COMPANY WHERE CIF_ID = '${c.cif_id}'
       UNION ALL
       SELECT PAN, 'consumer'          FROM VS_CIF.PARTNER WHERE CIF_ID = '${c.cif_id}') p;

INSERT INTO CREDORA_STAGE.AA_RAW
SELECT CREDORA.AA_FETCH(p.PAN, 'Loan underwriting', '${runId}')
FROM   VS_CIF.PARTNER p WHERE p.CIF_ID = '${c.cif_id}';`),
    },
    {
      name: "Match names across systems",
      what: "Spellings and initials differ between the bank, CIBIL, GSTN and the AA. NAME_MATCH embeds both names with MiniLM and keeps pairs above 0.86 cosine similarity.",
      engine: "Python UDF",
      object: "NAME_MATCH",
      language: "python",
      sources: ["bank.mysql", "api.cibil", "api.aa"],
      ms: 236,
      code: L(`
# CREDORA.NAME_MATCH  (SET SCRIPT, runs in the CREDORA_PY script language container)
from sentence_transformers import SentenceTransformer, util

model = SentenceTransformer("/buckets/bfsdefault/default/models/minilm")

def run(ctx):
    bank, ext, keys = [], [], []
    while True:
        bank.append(ctx.bank_name); ext.append(ctx.ext_name); keys.append(ctx.ext_key)
        if not ctx.next():
            break
    a = model.encode(bank, normalize_embeddings=True)
    b = model.encode(ext, normalize_embeddings=True)
    for i, key in enumerate(keys):
        sim = float(util.cos_sim(a[i], b[i]))
        ctx.emit(key, sim, sim >= 0.86)`),
    },
    {
      name: "Combine into one record",
      what: "Bank data and the three API results become one row per company.",
      engine: "SQL view",
      object: "CREDORA.V_COMPANY_360",
      language: "sql",
      sources: ["bank.oracle", "bank.mysql", "bank.postgres", "api.cibil", "api.gstn", "api.aa"],
      ms: 58,
      code: L(`
CREATE OR REPLACE VIEW CREDORA.V_COMPANY_360 AS
SELECT c.CIF_ID, c.LEGAL_NAME, c.CONSTITUTION, l.APP_ID, l.PRODUCT,
       l.AMOUNT_REQUESTED, l.TENURE_REQUESTED,
       g.YEARS_OF_FILING, g.STAGE,
       cm.CMR_RANK, cm.OVERDUE AS CMR_OVERDUE, cm.WILFUL_DEFAULT, cm.SUIT_FILED,
       pc.PARTNER_MIN_SCORE, pc.PARTNER_AVG_SCORE, pc.PARTNER_OVERDUE_AMT,
       aa.PARTNER_OTHER_BANK_BAL
FROM   VS_CIF.COMPANY c
JOIN   VS_LOS.APPLICATION l              ON l.CIF_ID = c.CIF_ID
LEFT JOIN CREDORA_STAGE.GST_REGISTRATION g ON g.GSTIN = c.GSTIN
LEFT JOIN CREDORA_STAGE.CIBIL_COMMERCIAL cm ON cm.PAN = c.PAN
LEFT JOIN CREDORA.V_PARTNER_CIBIL       pc ON pc.CIF_ID = c.CIF_ID
LEFT JOIN CREDORA.V_PARTNER_AA          aa ON aa.CIF_ID = c.CIF_ID;`),
    },
    {
      name: "Apply hard filters",
      what: s.hard_fail
        ? `Failed. ${s.hard_fail}. The company is declined whatever the model says.`
        : "Passed. No wilful default, no overdue with a poor CMR rank, every partner at 600 or above, GST filed.",
      engine: "SQL",
      object: "CREDORA.HARD_FILTERS",
      language: "sql",
      sources: ["api.cibil", "api.gstn"],
      ms: 21,
      code: L(`
SELECT CIF_ID,
       CASE WHEN WILFUL_DEFAULT                         THEN 'Wilful default flagged'
            WHEN CMR_OVERDUE > 0 AND CMR_RANK >= 8      THEN 'Overdue with CMR rank 8 or worse'
            WHEN PARTNER_MIN_SCORE < 600                THEN 'Partner CIBIL below cut-off'
            WHEN GST_LATE_FILINGS_12M >= 10             THEN 'GST not filed on time'
       END AS HARD_FAIL
FROM   CREDORA.V_COMPANY_360
WHERE  CIF_ID = '${c.cif_id}';`),
    },
    {
      name: "Build features",
      what: "Twelve months of cash flow and GST behaviour, computed with window functions over the bank's transactions and the GST returns.",
      engine: "SQL · window functions",
      object: "CREDORA.FEATURES",
      language: "sql",
      sources: ["bank.oracle", "api.gstn", "api.cibil", "api.aa"],
      ms: 187,
      code: L(`
WITH m AS (
  SELECT t.ACCOUNT_NO, TRUNC(t.TXN_DATE, 'MM')                       AS MON,
         SUM(CASE WHEN t.DR_CR = 'C' THEN t.AMOUNT END)               AS CREDITS,
         AVG(t.BALANCE_AFTER)                                         AS AVG_BAL,
         SUM(CASE WHEN t.BOUNCED = 'Y' THEN 1 ELSE 0 END)             AS BOUNCES,
         SUM(CASE WHEN t.DR_CR = 'D' THEN 1 ELSE 0 END)               AS DEBITS
  FROM   VS_CBS.TXN t
  WHERE  t.ACCOUNT_NO = '${c.account_no}'
    AND  t.TXN_DATE >= ADD_MONTHS(CURRENT_DATE, -12)
  GROUP  BY t.ACCOUNT_NO, TRUNC(t.TXN_DATE, 'MM')
)
SELECT AVG(AVG_BAL)                                        AS AVG_BALANCE_12M,
       STDDEV(CREDITS) / NULLIFZERO(AVG(CREDITS))          AS INFLOW_VOLATILITY,
       SUM(BOUNCES) / NULLIFZERO(SUM(DEBITS))              AS BOUNCE_RATIO,
       ABS(g.TURNOVER_12M - SUM(CREDITS))
         / NULLIFZERO(g.TURNOVER_12M) * 100                AS GST_BANK_GAP_PCT,
       g.LATE_FILINGS_12M                                  AS GST_LATE_FILINGS_12M
FROM   m
CROSS JOIN (SELECT SUM(GSTR1_TURNOVER)                           AS TURNOVER_12M,
                   SUM(CASE WHEN DELAY_DAYS > 0 OR FILED_ON IS NULL
                            THEN 1 ELSE 0 END)                   AS LATE_FILINGS_12M
            FROM   CREDORA_STAGE.GST_RAW
            WHERE  GSTIN = '${c.gstin}'
              AND  PERIOD >= TO_CHAR(ADD_MONTHS(CURRENT_DATE, -12), 'YYYY-MM')) g
GROUP  BY g.TURNOVER_12M, g.LATE_FILINGS_12M;`),
    },
    {
      name: "Score risk and explain it",
      what: `Gradient-boosted trees (scikit-learn HistGradientBoosting) give the probability of default, and feature attribution gives each feature's push up or down. PD ${(s.pd * 100).toFixed(2)}% maps to grade ${s.grade}.`,
      engine: "Python UDF",
      object: "PD_SCORE, EXPLAIN",
      language: "sql",
      sources: ["exasol"],
      ms: 344,
      code: L(`
-- Model files are versioned in BucketFS; the active version is read from CREDORA.MODEL_REGISTRY
SELECT f.CIF_ID,
       CREDORA.PD_SCORE(f.GST_YEARS, f.GST_TURNOVER_12M, f.GST_LATE_FILINGS_12M,
                        f.GST_BANK_GAP_PCT, f.AVG_BALANCE_12M, f.INFLOW_VOLATILITY,
                        f.BOUNCE_RATIO, f.CMR_RANK, f.PARTNER_MIN_SCORE, f.PARTNER_AVG_SCORE,
                        f.PARTNER_OVERDUE_AMT, f.PARTNER_OTHER_BANK_BAL, f.DSCR) AS PD
FROM   CREDORA.FEATURES f
WHERE  f.CIF_ID = '${c.cif_id}';

SELECT CREDORA.EXPLAIN(f.*) EMITS (CIF_ID VARCHAR(8), FEATURE VARCHAR(40), PD_DELTA DOUBLE)
FROM   CREDORA.FEATURES f
WHERE  f.CIF_ID = '${c.cif_id}'
ORDER  BY ABS(PD_DELTA) DESC
LIMIT  5;`),
    },
    {
      name: "Size the offer (amount, ROI, tenure)",
      what: "Amount is the smallest of the indicated need, 20% of GST turnover, and what cash flow can repay at DSCR 1.25. ROI is EBLR plus a risk spread and an operating spread.",
      engine: "SQL",
      object: "CREDORA.PRICING",
      language: "sql",
      sources: ["bank.postgres", "api.gstn", "exasol"],
      ms: 33,
      code: L(`
SELECT CIF_ID,
       LEAST(AMOUNT_REQUESTED,
             GST_TURNOVER_12M * :max_gst_share,
             (MONTHLY_CASH / 1.25) * ANNUITY_FACTOR(ROI, TENURE))      AS OFFER_AMOUNT,
       LEAST(:eblr + RISK_SPREAD(PD) + :op_spread, :roi_cap)          AS OFFER_ROI,
       LEAST(TENURE_REQUESTED,
             CASE PRODUCT WHEN 'WC' THEN 36 ELSE 60 END)              AS OFFER_TENURE
FROM   CREDORA.V_SCORED
WHERE  CIF_ID = '${c.cif_id}';`),
    },
    {
      name: "Flag unusual companies (anomaly model)",
      what: s.anomaly.flagged
        ? `Flagged for ${s.anomaly.reasons.join(", ")} (score ${s.anomaly.score.toFixed(3)}). Possible circular trading or inflated turnover, so the company is referred for review, never declined on it.`
        : `Not flagged (score ${s.anomaly.score.toFixed(3)}). An Isolation Forest looks at every company of the run at once and flags the most unusual 3%.`,
      engine: "Python UDF",
      object: "CREDORA.ANOMALY_FLAG",
      language: "sql",
      sources: ["exasol", "api.gstn", "bank.oracle", "api.aa"],
      ms: 1340,
      code: L(`
INSERT INTO CREDORA.ANOMALY
SELECT :r, app_id, score, is_anomaly, top_reasons
FROM (SELECT CREDORA.ANOMALY_FLAG(f.APP_ID, c.CONFIG_VALUE, f.GST_TURNOVER_12M, f.BANK_CREDITS_12M,
                                  f.AVG_BALANCE_12M, f.INFLOW_VOLATILITY, f.PARTNER_OTHER_BANK_BAL)
      FROM CREDORA.FEATURES f
      LEFT JOIN CREDORA.CONFIG c ON c.CONFIG_KEY = 'ANOMALY_CONTAMINATION_PCT'
      WHERE f.RUN_ID = '${runId}');`),
    },
    {
      name: "Set the negotiation limit and decide",
      what: `The floor ROI is the lowest rate at which RAROC still meets the 15% hurdle. Then Approve, Refer or Decline, with the reasons kept. A company the anomaly model flagged is referred, not approved.`,
      engine: "Lua script",
      object: "CREDORA.DECIDE",
      language: "lua",
      sources: ["exasol"],
      ms: 64,
      code: L(`
-- CREDORA.DECIDE: per-company decision, called by RUN_ANALYSIS
local hurdle, lgd, capital = 0.15, 0.45, 0.12
local r = query([[SELECT * FROM CREDORA.V_SCORED WHERE CIF_ID = :c]], {c = '${c.cif_id}'})[1]

local floor_roi = hurdle * capital * 100 + r.COST_OF_FUNDS + r.PD * 100 * lgd + r.OPEX
local raroc     = (r.OFFER_ROI - r.COST_OF_FUNDS - r.PD * 100 * lgd - r.OPEX) / capital

local decision
if r.HARD_FAIL ~= null or r.PD >= 0.14 then
  decision = 'DECLINE'
elseif raroc >= hurdle * 100 and r.PD < 0.06 then
  decision = 'APPROVE'
elseif raroc >= hurdle * 50 then
  decision = 'REFER'
else
  decision = 'DECLINE'
end

query([[MERGE INTO CREDORA.DECISIONS d USING DUAL ON d.CIF_ID = :c AND d.RUN_ID = :run
        WHEN NOT MATCHED THEN INSERT VALUES (:run, :c, :dec, :fl, :mx, :mt, :rr)]],
      {run = '${runId}', c = '${c.cif_id}', dec = decision,
       fl = floor_roi, mx = r.MAX_AMOUNT, mt = r.MAX_TENURE, rr = raroc})`),
    },
    {
      name: "Rank among all companies",
      what: "PREFERRING keeps the companies that no other company beats on all three together, meaning lower PD, higher RAROC and larger amount. Layers give the rank, and the first layers form the top 50.",
      engine: "SQL · PREFERRING",
      object: "CREDORA.RANKING",
      language: "sql",
      sources: ["exasol"],
      ms: 91,
      code: L(`
-- Skyline ranking: peel off Pareto layers until every company has a rank
SELECT CIF_ID, PD, RAROC_PCT AS RAROC, OFFER_AMOUNT
FROM   CREDORA.DECISIONS
WHERE  RUN_ID = '${runId}' AND DECISION <> 'DECLINE'
PREFERRING LOW PD
       PLUS HIGH RAROC_PCT
       PLUS HIGH OFFER_AMOUNT;`),
    },
  ];
  return steps.map((x, i) => ({ ...x, n: i + 1 }));
}

export function buildFeatures(c: Company, w: World, s: Scored): Feature[] {
  const ps = w.partners(c);
  const scores = ps.map((p) => p.score);
  const otherBal = ps.reduce((a, p) => a + p.aa_accounts.reduce((b, x) => b + x.current_balance, 0), 0);
  const f = (name: string, label: string, value: number | string | null, unit: string | null, source: SourceId): Feature => ({
    name,
    label,
    value,
    unit,
    source,
  });
  return [
    f("gst_years", "Years of GST filing", c.gst_years, "years", "api.gstn"),
    f("gst_turnover_12m", "GST turnover, last 12 months", c.turnover_12m, "inr", "api.gstn"),
    f("gst_late_filings_12m", "Late GST filings, last 12 months", c.late_filings_12m, null, "api.gstn"),
    f("gst_bank_gap_pct", "Gap between GST turnover and bank credits", c.gap_pct, "pct", "exasol"),
    f("avg_balance_12m", "Average balance, last 12 months", c.avg_balance, "inr", "bank.oracle"),
    f("inflow_volatility", "Inflow volatility (stddev / mean)", c.volatility, null, "bank.oracle"),
    f("bounce_ratio", "Bounced debits / all debits", c.bounce_ratio, "ratio", "bank.oracle"),
    f("cmr_rank", "CIBIL CMR rank (1 best, 10 worst)", c.cmr_rank, null, "api.cibil"),
    f("partner_min_score", "Lowest partner CIBIL score", Math.min(...scores), null, "api.cibil"),
    f("partner_avg_score", "Average partner CIBIL score", Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10, null, "api.cibil"),
    f("partner_overdue_amt", "Partners' overdue amount", ps.reduce((a, p) => a + p.overdue, 0), "inr", "api.cibil"),
    f("partner_other_bank_bal", "Partners' balances at other banks", otherBal, "inr", "api.aa"),
    f("dscr", "Debt service coverage ratio", s.dscr, null, "exasol"),
  ];
}

export function buildReasons(c: Company, w: World): Reason[] {
  const ps = w.partners(c);
  const minP = ps.reduce((a, p) => (p.score < a.score ? p : a), ps[0]);
  const enq = ps.reduce((a, p) => (p.enquiries_6m > a.enquiries_6m ? p : a), ps[0]);
  const cands: Reason[] = [
    {
      feature: "gst_bank_gap_pct",
      source: "exasol",
      contribution: (c.gap_pct - 12) / 22,
      text: c.gap_pct < 12 ? `GST turnover matches bank credits (gap ${c.gap_pct.toFixed(1)}%)` : `GST turnover is ${c.gap_pct.toFixed(0)}% away from bank credits`,
    },
    {
      feature: "bounce_ratio",
      source: "bank.oracle",
      contribution: (c.bounce_ratio - 0.012) * 22,
      text: c.bounce_ratio < 0.004 ? `No bounced debits in ${c.txn_months} months` : `${(c.bounce_ratio * 100).toFixed(1)}% of debits bounced`,
    },
    {
      feature: "partner_min_score",
      source: "api.cibil",
      contribution: (700 - minP.score) / 140,
      text: minP.score >= 740 ? `All partners have CIBIL scores of 740 or more` : `${minP.name} has a CIBIL score of ${minP.score}`,
    },
    {
      feature: "gst_late_filings_12m",
      source: "api.gstn",
      contribution: (c.late_filings_12m - 2) / 6,
      text: c.late_filings_12m === 0 ? "Every GST return in the last 12 months filed on time" : `${c.late_filings_12m} GST returns filed late in the last 12 months`,
    },
    {
      feature: "cmr_rank",
      source: "api.cibil",
      contribution: (c.cmr_rank - 4) / 5,
      text: `CIBIL commercial rank CMR-${c.cmr_rank}`,
    },
    {
      feature: "inflow_volatility",
      source: "bank.oracle",
      contribution: (c.volatility - 0.3) * 1.6,
      text: c.volatility < 0.3 ? "Steady monthly inflows into the current account" : "Monthly inflows swing widely",
    },
    {
      feature: "gst_years",
      source: "api.gstn",
      contribution: (5 - c.gst_years) / 12,
      text: `${c.gst_years} years of GST history (${c.stage})`,
    },
    {
      feature: "partner_enquiries",
      source: "api.cibil",
      contribution: enq.enquiries_6m / 7,
      text: enq.enquiries_6m > 0 ? `${enq.name} has ${enq.enquiries_6m} credit enquiries in 6 months` : "No recent credit enquiries on partners",
    },
  ];
  return cands
    .map((r) => ({ ...r, contribution: Math.round(r.contribution * 1000) / 1000 }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 6);
}

export type { Report };
