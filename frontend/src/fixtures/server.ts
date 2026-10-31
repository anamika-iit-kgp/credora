// In-browser fixture server for `npm run dev:fixtures`.
// Answers /api/* with synthetic data that follows docs/API.md. Never bundled in a normal build.

import type {
  AskAnswer,
  AskStep,
  AuditEntry,
  CompanyRow,
  CreditMemo,
  DecisionMix,
  DecisionRow,
  Job,
  JobStep,
  Model,
  ModelComparison,
  NodeRecords,
  Offer,
  OfferEvent,
  OfferStage,
  Overview,
  PurgeEntry,
  Report,
  Role,
  Run,
  SourceHealth,
  SourceId,
  Top50Row,
  TreeNode,
  User,
  WhatIfResult,
} from "../api/types";
import type { PolicyLeverChange, PolicyProposal, WhatIfRun } from "../api/types";
import type { ActivationRequest, LoanStatus, LoanStatusEvent, LoanStatusRow } from "../api/types";
import { num, rupeesShort } from "../lib/format";
import { buildFeatures, buildReasons, buildSteps } from "./report";
import { exasolFixture, recordFixture } from "./exasol";
import {
  AS_OF,
  BASE_POLICY,
  type Company,
  DEMO_RM,
  emi,
  mulberry32,
  type Policy,
  RMS,
  rarocOf,
  score,
  type Scored,
  World,
} from "./world";

/* ------------------------------ users ------------------------------ */

const USERS: Record<string, User> = {
  admin: { username: "admin", role: "admin", display_name: "Kavita Menon" },
  datasci: { username: "datasci", role: "datasci", display_name: "Arjun Iyer" },
  loanops: { username: "loanops", role: "loanops", display_name: "Farah Siddiqui" },
  rm: { username: "rm", role: "rm", display_name: "Subhashree Mohanty (RM001)" },
};

/* ------------------------------ state ------------------------------ */

interface Persisted {
  seed: number;
  companies?: number; // 1,000 after a replace; grows with "Add more companies"
  generated_at: string;
  analysed: boolean;
  runs: Run[];
  models: Model[];
  offerPatches: Record<number, Partial<Offer>>;
  events: OfferEvent[];
  audit: AuditEntry[];
  policy?: Policy; // CREDORA.CONFIG levers; BASE_POLICY until an approved proposal changes them
  whatifRuns?: WhatIfRun[];
  proposals?: PolicyProposal[];
  // Hand-offs between the roles (see wf() below): CREDORA.RUN_PUBLISH, CREDORA.RM_ASSIGNMENT,
  // CREDORA.LOAN_STATUS_LOG and crm.model_activation_request.
  published?: Record<string, { by: string; at: string; note: string | null }>;
  assignments?: Record<string, { rm_id: string; assigned_by: string; assigned_at: string }>;
  statusLog?: LoanStatusEvent[];
  activations?: ActivationRequest[];
}

const KEY = "credora.fixtures.v2";
const now = () => new Date().toISOString();
const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();

function initialModels(): Model[] {
  const fi = (bias: number) =>
    [
      ["gst_bank_gap_pct", 0.19],
      ["partner_min_score", 0.16],
      ["bounce_ratio", 0.13],
      ["cmr_rank", 0.11],
      ["gst_late_filings_12m", 0.1],
      ["inflow_volatility", 0.08],
      ["dscr", 0.07],
      ["partner_avg_score", 0.05],
      ["avg_balance_12m", 0.04],
      ["gst_years", 0.03],
      ["partner_other_bank_bal", 0.02],
      ["partner_overdue_amt", 0.02],
    ].map(([f, v], i) => ({ feature: f as string, importance: Math.round(((v as number) + (i % 2 ? bias : -bias)) * 1000) / 1000 }));
  return [
    { version: "pd-v1", algorithm: "Gradient-boosted trees (scikit-learn HistGradientBoosting)", trained_at: minsAgo(60 * 24 * 6), trained_by: "datasci", train_rows: 4120, auc: 0.781, gini: 0.562, active: false, feature_importance: fi(0.012) },
    { version: "pd-v1-lr", algorithm: SCORECARD, kind: "coefficient", trained_at: minsAgo(60 * 24 * 6 - 1), trained_by: "datasci", train_rows: 4120, auc: 0.789, gini: 0.578, active: false, feature_importance: coefficients(0.02) },
    { version: "pd-v2", algorithm: "Gradient-boosted trees (scikit-learn HistGradientBoosting)", trained_at: minsAgo(60 * 26), trained_by: "datasci", train_rows: 4120, auc: 0.812, gini: 0.624, active: true, feature_importance: fi(0) },
    { version: "pd-v2-lr", algorithm: SCORECARD, kind: "coefficient", trained_at: minsAgo(60 * 26 - 1), trained_by: "datasci", train_rows: 4120, auc: 0.821, gini: 0.642, active: false, feature_importance: coefficients(0) },
  ];
}

const SCORECARD = "LogisticRegression scorecard";
const isScorecard = (m: Model) => m.algorithm.startsWith("LogisticRegression");

/** Signed scorecard coefficients (log-odds per standard deviation), biggest effect first. */
function coefficients(bias: number) {
  return [
    ["avg_balance_12m", -0.47],
    ["partner_avg_score", -0.46],
    ["gst_turnover_12m", 0.39],
    ["cmr_rank", 0.29],
    ["gst_late_filings_12m", 0.22],
    ["partner_min_score", 0.085],
    ["bounce_ratio", 0.078],
    ["dscr", -0.05],
    ["inflow_volatility", 0.03],
    ["partner_other_bank_bal", -0.028],
    ["gst_years", 0.018],
    ["partner_overdue_amt", -0.016],
    ["gst_bank_gap_pct", -0.004],
  ].map(([f, v]) => ({ feature: f as string, importance: Math.round((v as number) * (1 + bias) * 1000) / 1000 }));
}

/** The challenger: the newest inactive model of another algorithm than the active one. */
function challengerOf(models: Model[]): Model | null {
  const champ = models.find((m) => m.active);
  if (!champ) return null;
  const others = models.filter((m) => !m.active && m.algorithm !== champ.algorithm);
  return others.sort((a, b) => b.trained_at.localeCompare(a.trained_at))[0] ?? null;
}

function initialRuns(): Run[] {
  return [
    mkRun("R20261029-01", minsAgo(60 * 50), "pd-v1", [0.57, 0.27, 0.16]),
    mkRun("R20261030-01", minsAgo(60 * 25), "pd-v2", [0.59, 0.26, 0.15]),
    mkRun("R20261031-01", minsAgo(42), "pd-v2", null),
  ];
}

const RUN_STAGES = [
  "Read bank data (virtual schemas)",
  "Fetch CIBIL (CIBIL_FETCH)",
  "Fetch GST (GST_FETCH)",
  "Fetch AA (AA_FETCH)",
  "Match names (NAME_MATCH)",
  "Build features",
  "Score PD and feature attribution",
  "Decide (CREDORA.DECIDE)",
  "Rank (PREFERRING)",
  "Export offers to CRM",
];
const STAGE_MS = [4200, 18600, 14900, 21300, 6100, 3800, 9700, 2600, 1400, 2900];

function mkRun(run_id: string, started: string, model: string, mix: [number, number, number] | null): Run {
  let h = 7;
  for (let i = 0; i < run_id.length; i++) h = Math.imul(h ^ run_id.charCodeAt(i), 2654435761);
  const r = mulberry32(h);
  const stages = RUN_STAGES.map((name, i) => ({ name, ms: Math.round(STAGE_MS[i] * (0.85 + r() * 0.3)) }));
  const total = stages.reduce((a, s) => a + s.ms, 0);
  const m = mix ?? [0.58, 0.27, 0.15];
  return {
    run_id,
    status: "done",
    started_at: started,
    finished_at: new Date(new Date(started).getTime() + total).toISOString(),
    started_by: "loanops",
    model_version: model,
    companies: 1000,
    approve: Math.round(m[0] * 1000),
    refer: Math.round(m[1] * 1000),
    decline: 1000 - Math.round(m[0] * 1000) - Math.round(m[1] * 1000),
    stages,
  };
}

function initialAudit(): AuditEntry[] {
  const e = (m: number, username: string, role: Role, action: string, target: string, detail: string | null = null): AuditEntry => ({
    at: minsAgo(m),
    username,
    role,
    action,
    target,
    detail,
  });
  return [
    e(4, "rm", "rm", "VIEW_REPORT", "C000417", "Exasol report"),
    e(9, "loanops", "loanops", "VIEW_NODE", "C000088:account", "Current account statement"),
    e(16, "datasci", "datasci", "WHAT_IF", "policy", "hurdle 16%, EBLR 8.25%, GST share 20%"),
    e(42, "loanops", "loanops", "RUN_ANALYSIS", "R20261031-01", "1,000 companies"),
    e(71, "datasci", "datasci", "ACTIVATE_MODEL", "pd-v2", null),
    e(95, "admin", "admin", "GENERATE", "seed 20261031", "cleared and regenerated all data"),
    e(130, "admin", "admin", "LOGIN", "admin", null),
  ];
}

function fresh(seed = 20261031): Persisted {
  return {
    seed,
    generated_at: minsAgo(95),
    analysed: true,
    runs: initialRuns(),
    models: initialModels(),
    offerPatches: {},
    events: [],
    audit: initialAudit(),
  };
}

let S: Persisted = load();
function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Persisted;
      // state saved before the challenger existed: add the scorecards next to the trees
      if (!p.models.some(isScorecard)) p.models = [...p.models, ...initialModels().filter(isScorecard)];
      return p;
    }
  } catch {
    /* ignore */
  }
  return fresh();
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch {
    /* ignore */
  }
}

let world = new World(S.seed, S.companies);
let scoredCache: { key: string; scored: Scored[]; ranks: number[] } | null = null;

function activeModel() {
  return S.models.find((m) => m.active) ?? S.models[S.models.length - 1];
}
function modelBias(v: Model = activeModel()) {
  const n = Number(v.version.replace(/-lr$/, "").replace(/\D/g, "")) || 2;
  return (2 - n) * 0.003 + (isScorecard(v) ? -0.0025 : 0);
}

/** The policy in force (CREDORA.CONFIG): changed only by an approved policy proposal. */
const currentPolicy = (): Policy => S.policy ?? BASE_POLICY;

function scored() {
  const pol = currentPolicy();
  const key = `${S.seed}:${activeModel().version}:${pol.hurdle_pct}:${pol.eblr_pct}:${pol.max_gst_share_pct}`;
  if (scoredCache?.key === key) return scoredCache;
  const all = world.all();
  const sc = all.map((c) => score(world, c, modelBias(), pol));
  const order = all
    .map((_, i) => i)
    .sort((a, b) => {
      const order = { APPROVE: 0, REFER: 1, DECLINE: 2 } as const;
      const da = order[sc[a].decision];
      const db = order[sc[b].decision];
      if (da !== db) return da - db;
      return sc[a].pd - sc[a].raroc / 4000 - (sc[b].pd - sc[b].raroc / 4000);
    });
  const ranks = new Array<number>(all.length);
  order.forEach((idx, k) => (ranks[idx] = k + 1));
  scoredCache = { key, scored: sc, ranks };
  return scoredCache;
}

function mix(): DecisionMix {
  const m: DecisionMix = { APPROVE: 0, REFER: 0, DECLINE: 0 };
  for (const s of scored().scored) m[s.decision]++;
  return m;
}

function lastRun(): Run | null {
  return S.analysed ? S.runs[S.runs.length - 1] ?? null : null;
}

/* ------------------------------ offers ------------------------------ */

function baseOffer(c: Company): Offer | null {
  if (!S.analysed) return null;
  const { scored: sc, ranks } = scored();
  const s = sc[c.idx];
  if (s.decision === "DECLINE") return null;
  const r = world.rng(`offer:${c.cif_id}`);
  const roll = r();
  const stage: OfferStage =
    roll < 0.66 ? "OFFERED" : roll < 0.8 ? "NEGOTIATING" : roll < 0.87 ? "ESCALATED" : roll < 0.93 ? "VERIFIED" : "SANCTIONED";
  const agreed =
    stage === "OFFERED"
      ? null
      : stage === "ESCALATED"
        ? { amount: Math.round((s.max_amount * 1.08) / 500000) * 500000, roi: Math.max(7, s.floor_roi - 0.25), tenure: s.tenure }
        : { amount: s.amount, roi: Math.round((s.roi - (s.roi - s.floor_roi) * 0.5) * 20) / 20, tenure: s.tenure };
  return {
    offer_id: c.idx + 1,
    run_id: lastRun()?.run_id ?? "",
    app_id: c.app_id,
    cif_id: c.cif_id,
    legal_name: c.legal_name,
    rm_id: c.rm_id,
    decision: s.decision,
    grade: s.grade,
    pd: s.pd,
    rank_no: ranks[c.idx],
    offer_amount: s.amount,
    offer_roi: s.roi,
    offer_tenure: s.tenure,
    floor_roi: s.floor_roi,
    max_amount: s.max_amount,
    max_tenure: s.max_tenure,
    stage,
    agreed_amount: agreed?.amount ?? null,
    agreed_roi: agreed?.roi ?? null,
    agreed_tenure: agreed?.tenure ?? null,
    updated_at: new Date(Date.now() - Math.floor(r() * 3 * 86400000)).toISOString(),
  };
}

function offerById(id: number): Offer | null {
  const c = world.company(id - 1);
  if (!c) return null;
  const b = baseOffer(c);
  if (!b) return null;
  return { ...b, ...(S.offerPatches[id] ?? {}) };
}

function allOffers(): Offer[] {
  if (!S.analysed) return [];
  const out: Offer[] = [];
  for (const c of world.all()) {
    const o = offerById(c.idx + 1);
    if (o) out.push(o);
  }
  return out;
}

function syntheticEvents(o: Offer): OfferEvent[] {
  const base = S.events.filter((e) => e.offer_id === o.offer_id);
  const seeded: OfferEvent[] = [];
  const t0 = new Date(o.updated_at).getTime();
  const ev = (k: number, actor: string, action: string, note: string | null, terms = true): OfferEvent => ({
    event_id: o.offer_id * 100 + k,
    offer_id: o.offer_id,
    actor,
    action,
    amount: terms ? o.agreed_amount : null,
    roi: terms ? o.agreed_roi : null,
    tenure: terms ? o.agreed_tenure : null,
    note,
    at: new Date(t0 - (6 - k) * 3600000 * 5).toISOString(),
  });
  const original = baseOffer(world.company(o.offer_id - 1))!;
  if (original.stage !== "OFFERED") {
    seeded.push(ev(1, "rm", "PROPOSE", "Customer wanted a sharper rate against a larger limit. Agreed on these terms."));
    if (original.stage === "ESCALATED") seeded.push(ev(2, "system", "ESCALATE", "Terms outside the negotiation limit. ROI below floor.", false));
    if (original.stage === "VERIFIED" || original.stage === "SANCTIONED")
      seeded.push(ev(3, "loanops", "VERIFY", "KYC current, collateral valuation on file.", false));
    if (original.stage === "SANCTIONED") seeded.push(ev(4, "loanops2", "SANCTION", "Sanctioned within delegated authority.", false));
  }
  return [...seeded, ...base].sort((a, b) => a.at.localeCompare(b.at));
}

/* ------------------------------ jobs ------------------------------ */

interface JobDef {
  job_id: string;
  kind: string;
  started: number;
  steps: { name: string; ms: number; detail: string }[];
  applied: boolean;
  onDone: () => void;
}
const jobs = new Map<string, JobDef>();

function startJob(kind: string, steps: JobDef["steps"], onDone: () => void) {
  const job_id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(job_id, { job_id, kind, started: Date.now(), steps, applied: false, onDone });
  return { job_id };
}

function jobState(j: JobDef): Job {
  const elapsed = Date.now() - j.started;
  const total = j.steps.reduce((a, s) => a + s.ms, 0);
  let acc = 0;
  const steps: JobStep[] = j.steps.map((s) => {
    const start = acc;
    acc += s.ms;
    if (elapsed >= acc) return { name: s.name, status: "done", detail: s.detail };
    if (elapsed >= start) return { name: s.name, status: "running", detail: null };
    return { name: s.name, status: "pending", detail: null };
  });
  const done = elapsed >= total;
  if (done && !j.applied) {
    j.applied = true;
    j.onDone();
    save();
  }
  return {
    job_id: j.job_id,
    kind: j.kind,
    status: done ? "done" : "running",
    progress: Math.min(100, Math.round((elapsed / total) * 100)),
    steps,
    started_at: new Date(j.started).toISOString(),
    finished_at: done ? new Date(j.started + total).toISOString() : null,
    error: null,
  };
}

/* ------------------------------ helpers ------------------------------ */

class HttpError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}
const need = (u: User, roles: Role[]) => {
  if (!roles.includes(u.role)) throw new HttpError(403, `The ${u.role} role cannot use this endpoint.`);
};
const audit = (u: User, action: string, target: string, detail: string | null = null) => {
  S.audit.unshift({ at: now(), username: u.username, role: u.role, action, target, detail });
  S.audit = S.audit.slice(0, 300);
};
const mask = (s: string, keep = 4) => `${"•".repeat(Math.max(0, s.length - keep))}${s.slice(-keep)}`;

function companyFor(u: User, cif: string): Company {
  const c = world.byCif(cif);
  if (!c) throw new HttpError(404, `No company with CIF ${cif}.`);
  // Exasol returns a company to CREDORA_RM only when it is assigned to her (V_RM_* views).
  if (u.role === "rm" && !assignedToMe(c.cif_id)) throw new HttpError(403, `${c.cif_id} is not assigned to you.`);
  return c;
}

function sees(u: User, src: SourceId) {
  return !(src.startsWith("api.") && (u.role === "rm" || u.role === "loanops"));
}

/* ------------------------------ tree + nodes ------------------------------ */

function tree(u: User, c: Company): TreeNode {
  const ps = world.partners(c);
  const n = (id: string, label: string, sublabel: string | null, source: SourceId | null, kind: string, children: TreeNode[] = []): TreeNode => ({
    id,
    label,
    sublabel,
    source,
    kind,
    children,
  });
  const rmMask = false; // an RM sees her assigned companies at full detail (V_RM_COMPANY: PAN and GSTIN unmasked)
  const years = world.gstYears(c);
  const sc = S.analysed ? scored() : null;
  const kids: TreeNode[] = [
    n(`${c.cif_id}:account`, `Current account ••${c.account_no.slice(-4)}`, `${c.account_branch}`, "bank.oracle", "account", [
      n(`${c.cif_id}:txns`, "Transactions", `${c.txn_months} months`, "bank.oracle", "transactions"),
    ]),
    n(`${c.cif_id}:application`, `Credit need on file ${c.app_id}`, `${fmtCr(c.amount_requested)} · ${c.tenure_requested} months · ${c.product === "WC" ? "working capital" : "term loan"}`, "bank.postgres", "application"),
    n(
      `${c.cif_id}:gst`,
      `GST ${rmMask ? mask(c.gstin) : c.gstin}`,
      `${c.gst_years} years · ${c.stage}`,
      "api.gstn",
      "gst",
      years.map((y) => n(`${c.cif_id}:gst:${y}`, `${y}`, "Monthly GSTR-1 and GSTR-3B", "api.gstn", "gst_year")),
    ),
    n(`${c.cif_id}:cibil`, `CIBIL commercial`, `CMR rank ${c.cmr_rank} · ${c.facilities} facilities`, "api.cibil", "cibil_commercial"),
    ...ps.map((p, k) =>
      n(`${c.cif_id}:partner:${p.partner_id}`, `Partner ${k + 1} · ${p.name}`, `${p.role} · ${p.share_pct.toFixed(2)}%`, "bank.mysql", "partner", [
        n(`${c.cif_id}:partner:${p.partner_id}:cibil`, `CIBIL ${p.score}`, `${p.bureau_accounts} accounts · ${p.overdue > 0 ? "overdue" : "0 overdue"}`, "api.cibil", "cibil_consumer"),
        ...(p.sapphire_acct
          ? [n(`${c.cif_id}:partner:${p.partner_id}:sapphire`, `Savings ••${p.sapphire_acct.slice(-4)} at Sapphire Bank`, null, "bank.oracle", "partner_account")]
          : []),
        ...p.aa_accounts.map((a) =>
          n(`${c.cif_id}:partner:${p.partner_id}:aa:${a.aa_account_id}`, `${a.acct_type === "SAVINGS" ? "Savings" : "Current"} at ${a.fip}`, a.masked_no, "api.aa", "aa_account"),
        ),
      ]),
    ),
  ];
  if (sc) {
    const s = sc.scored[c.idx];
    kids.push(
      n(`${c.cif_id}:report`, "Exasol report", `${title(s.decision)} · grade ${s.grade} · rank ${sc.ranks[c.idx]} of ${num(world.size)}`, "exasol", "report"),
    );
  }
  const filter = (t: TreeNode): TreeNode | null =>
    t.source && !sees(u, t.source) ? null : { ...t, children: t.children.map(filter).filter(Boolean) as TreeNode[] };
  return n(c.cif_id, c.legal_name, `${c.cif_id} · ${c.constitution} · ${c.city}`, "bank.mysql", "company", kids.map(filter).filter(Boolean) as TreeNode[]);
}

const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
function fmtCr(n: number) {
  return n >= 1e7 ? `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, "")} cr` : `₹${(n / 1e5).toFixed(1).replace(/\.0$/, "")} L`;
}

function single(node_id: string, titleText: string, source: SourceId, obj: Record<string, unknown>, meta: Record<string, unknown> = {}): NodeRecords {
  const columns = Object.keys(obj);
  return { node_id, title: titleText, source, columns, rows: [columns.map((k) => obj[k] as never)], meta: meta as never };
}
function table(node_id: string, titleText: string, source: SourceId, rows: Record<string, unknown>[], meta: Record<string, unknown> = {}): NodeRecords {
  const columns = rows.length ? Object.keys(rows[0]).filter((k) => !k.startsWith("_")) : [];
  return { node_id, title: titleText, source, columns, rows: rows.map((r) => columns.map((k) => r[k] as never)), meta: meta as never };
}

function node(u: User, id: string): NodeRecords {
  const parts = id.split(":");
  const c = companyFor(u, parts[0]);
  const rmMask = false; // assigned companies only (companyFor), shown unmasked
  const ps = world.partners(c);
  const kind = parts[1] ?? "company";
  const deny = (src: SourceId) => {
    if (!sees(u, src)) throw new HttpError(403, "3rd party API records are shown to your role only through the Exasol report.");
  };
  switch (kind) {
    case "company":
      return single(id, c.legal_name, "bank.mysql", {
        cif_id: c.cif_id,
        legal_name: c.legal_name,
        constitution: c.constitution,
        pan: rmMask ? mask(c.pan) : c.pan,
        gstin: rmMask ? mask(c.gstin) : c.gstin,
        incorporated_on: c.incorporated_on,
        industry: c.industry,
        city: c.city,
        state: c.state,
        rm_id: c.rm_id,
        kyc_status: c.kyc_status,
        kyc_expiry: c.kyc_expiry,
        customer_since: c.customer_since,
      }, { table: "cif.company", database: "MySQL" });
    case "account":
      return single(id, `Current account ${rmMask ? mask(c.account_no) : c.account_no}`, "bank.oracle", {
        account_no: rmMask ? mask(c.account_no) : c.account_no,
        owner_type: "COMPANY",
        owner_id: c.cif_id,
        acct_type: "CA",
        branch: c.account_branch,
        opened_on: c.account_opened,
        status: "ACTIVE",
        od_limit: 0,
      }, { table: "CBS.ACCOUNT", database: "Oracle" });
    case "txns": {
      const rows = world.companyTxns(c);
      return table(id, `Transactions on ••${c.account_no.slice(-4)}`, "bank.oracle", rows, {
        table: "CBS.TXN",
        database: "Oracle",
        months: c.txn_months,
        rows: rows.length,
        bounced: rows.filter((r) => r.bounced === "Y").length,
      });
    }
    case "application":
      return single(id, `Credit need on file ${c.app_id}`, "bank.postgres", {
        app_id: c.app_id,
        cif_id: c.cif_id,
        applied_on: c.applied_on,
        product: c.product,
        amount_requested: c.amount_requested,
        tenure_requested: c.tenure_requested,
        purpose: c.purpose,
        collateral_type: c.collateral_type,
        collateral_value: c.collateral_value,
        status: S.analysed ? "ANALYSED" : "NEW",
      }, { table: "los.application", database: "PostgreSQL" });
    case "gst": {
      deny("api.gstn");
      if (parts[2]) {
        const rows = world.gstReturns(c, Number(parts[2]));
        return table(id, `GST returns ${parts[2]}`, "api.gstn", rows, {
          endpoint: `GET /v1/gstin/${c.gstin}/returns?from=${parts[2]}-01&to=${parts[2]}-12`,
          returns: rows.length,
          late: rows.filter((r) => (r.delay_days ?? 1) > 0).length,
        });
      }
      return single(id, `GSTIN ${c.gstin}`, "api.gstn", {
        gstin: c.gstin,
        legal_name: c.legal_name,
        pan: c.pan,
        state: c.state,
        registered_on: c.gst_registered_on,
        status: c.late_filings_12m >= 11 ? "SUSPENDED" : "ACTIVE",
        years_of_filing: c.gst_years,
        stage: c.stage,
      }, { endpoint: `GET /v1/gstin/${c.gstin}` });
    }
    case "cibil":
      deny("api.cibil");
      return single(id, "CIBIL commercial report", "api.cibil", {
        pan: c.pan,
        name: c.legal_name.toUpperCase(),
        cmr_rank: c.cmr_rank,
        report_date: "2026-10-31",
        total_exposure: c.cmr_exposure,
        overdue: c.cmr_overdue,
        suit_filed: c.suit_filed,
        wilful_default: c.wilful_default,
        facilities: c.facilities,
      }, { endpoint: `GET /v1/commercial/${c.pan}` });
    case "partner": {
      const p = ps.find((x) => x.partner_id === parts[2]);
      if (!p) throw new HttpError(404, "No such partner.");
      const sub = parts[3];
      if (!sub)
        return single(id, p.name, "bank.mysql", {
          partner_id: p.partner_id,
          cif_id: c.cif_id,
          name: p.name,
          pan: rmMask ? mask(p.pan) : p.pan,
          dob: rmMask ? "••••-••-••" : p.dob,
          gender: p.gender,
          role: p.role,
          share_pct: p.share_pct,
          city: p.city,
          sapphire_customer: p.sapphire_customer,
        }, { table: "cif.partner", database: "MySQL" });
      if (sub === "cibil") {
        deny("api.cibil");
        const accts = world.bureauAccounts(p).map((a) => ({
          lender: a.lender,
          acct_type: a.acct_type,
          opened_on: a.opened_on,
          sanctioned: a.sanctioned,
          balance: a.balance,
          overdue: a.overdue,
          status: a.status,
          worst_dpd_36m: Math.max(...a.dpd_36m.split(",").map(Number)),
          dpd_36m: a.dpd_36m,
        }));
        return table(id, `CIBIL consumer report for ${p.name}`, "api.cibil", accts, {
          endpoint: `GET /v1/consumer/${p.pan}`,
          pan: p.pan,
          score: p.score,
          report_date: "2026-10-31",
          enquiries_6m: p.enquiries_6m,
          enquiries_12m: p.enquiries_12m,
        });
      }
      if (sub === "sapphire" && p.sapphire_acct)
        return single(id, `Savings account ${p.sapphire_acct}`, "bank.oracle", {
          account_no: rmMask ? mask(p.sapphire_acct) : p.sapphire_acct,
          owner_type: "PARTNER",
          owner_id: p.partner_id,
          acct_type: "SA",
          branch: c.account_branch,
          opened_on: p.aa_accounts[0]?.opened_on ?? c.account_opened,
          status: "ACTIVE",
          od_limit: 0,
        }, { table: "CBS.ACCOUNT", database: "Oracle" });
      if (sub === "aa") {
        deny("api.aa");
        const a = p.aa_accounts.find((x) => x.aa_account_id === parts[4]);
        if (!a) throw new HttpError(404, "No such account.");
        return table(id, `${a.fip} ${a.acct_type.toLowerCase()} ${a.masked_no}`, "api.aa", world.aaTxns(a), {
          endpoint: `GET /v1/fi/{consent_id}`,
          consent_purpose: "Loan underwriting",
          aa_account_id: a.aa_account_id,
          fip: a.fip,
          acct_type: a.acct_type,
          opened_on: a.opened_on,
          current_balance: a.current_balance,
        });
      }
      throw new HttpError(404, "No such node.");
    }
    case "report": {
      const r = report(c);
      return single(id, "Exasol report", "exasol", {
        run_id: r.run_id,
        decision: r.decision,
        grade: r.grade,
        pd: r.pd,
        rank_no: r.rank_no,
        offer_amount: r.offer?.amount ?? null,
        offer_roi: r.offer?.roi ?? null,
        offer_tenure: r.offer?.tenure ?? null,
        max_amount: r.limit?.max_amount ?? null,
        floor_roi: r.limit?.floor_roi ?? null,
        max_tenure: r.limit?.max_tenure ?? null,
      }, { table: "CREDORA.DECISIONS", model: r.model_version });
    }
  }
  throw new HttpError(404, "No such node.");
}

/* ------------------------------ report ------------------------------ */

function report(c: Company, u?: User): Report {
  if (!S.analysed) throw new HttpError(404, "No analysis has run on this data set yet. Run analysis to create Exasol reports.");
  const { scored: sc, ranks } = scored();
  const s = sc[c.idx];
  const run = lastRun()!;
  const ps = world.partners(c);
  const flags = [s.hard_fail, s.anomaly.flagged ? `Anomaly: ${s.anomaly.reasons.join(", ")}` : null].filter((x): x is string => !!x);
  return {
    hard_fails: flags,
    // CREDORA_RM has no grant on CREDORA.ANOMALY: relationship managers see only the reason text
    anomaly: u?.role === "rm" ? null : s.anomaly,
    cif_id: c.cif_id,
    legal_name: c.legal_name,
    run_id: run.run_id,
    model_version: run.model_version,
    generated_at: run.finished_at ?? run.started_at,
    stage: c.stage,
    gst_years: c.gst_years,
    partners: ps.length,
    decision: s.decision,
    grade: s.grade,
    pd: s.pd,
    rank_no: ranks[c.idx],
    rank_of: world.size,
    raroc: s.raroc,
    offer: s.decision === "DECLINE" ? null : { amount: s.amount, roi: s.roi, tenure: s.tenure },
    limit: s.decision === "DECLINE" ? null : { max_amount: s.max_amount, floor_roi: s.floor_roi, max_tenure: s.max_tenure },
    requested: { amount: c.amount_requested, roi: 0, tenure: c.tenure_requested, product: c.product === "WC" ? "Working capital" : "Term loan" },
    offer_id: s.decision === "DECLINE" ? null : c.idx + 1,
    reasons: buildReasons(c, world),
    features: buildFeatures(c, world, s),
    steps: buildSteps(c, s, ps.length, run.run_id),
    sources_used: ["bank.oracle", "bank.mysql", "bank.postgres", "api.cibil", "api.gstn", "api.aa", "exasol"],
  };
}

/* ------------------------------ sources ------------------------------ */

function sources(): SourceHealth[] {
  const all = world.all();
  const partners = all.reduce((a, c) => a + c.partner_count, 0);
  const txns = all.reduce((a, c) => a + c.txn_months * 20, 0);
  const sapphirePartners = Math.round(partners * 0.3);
  const aaAccts = partners * 2;
  const filings = all.reduce((a, c) => a + c.gst_years * 12, 0);
  const r = mulberry32(Math.floor(Date.now() / 30000));
  const lat = (lo: number, hi: number) => Math.round(lo + r() * (hi - lo));
  const s = (source: SourceId, label: string, kind: SourceHealth["kind"], tables: [string, number][], latency: number): SourceHealth => ({
    source,
    label,
    kind,
    status: "up",
    tables: tables.map(([name, rows]) => ({ name, rows })),
    latency_ms: latency,
  });
  const n = world.size;
  const res = S.analysed ? n : 0;
  return [
    s("bank.oracle", "Sapphire Bank · Oracle (core banking)", "bank", [["CBS.ACCOUNT", n + sapphirePartners], ["CBS.TXN", txns]], lat(9, 22)),
    s("bank.mysql", "Sapphire Bank · MySQL (customer master)", "bank", [["cif.company", n], ["cif.partner", partners], ["cif.rm", RMS.length]], lat(4, 12)),
    s("bank.postgres", "Sapphire Bank · PostgreSQL (loans and CRM)", "bank", [["los.application", n], ["los.past_loan", 4120], ["crm.offer", S.analysed ? allOffers().length : 0], ["crm.offer_event", S.events.length + 212]], lat(5, 14)),
    s("api.cibil", "API · CIBIL (mock)", "api", [["consumer_report", partners], ["commercial_report", n]], lat(28, 70)),
    s("api.gstn", "API · GSTN (mock)", "api", [["registration", n], ["filing", filings]], lat(31, 80)),
    s("api.aa", "API · Account Aggregator (mock)", "api", [["fi_account", aaAccts], ["fi_txn", aaAccts * 40]], lat(35, 90)),
    s("exasol", "Exasol result", "exasol", [["CREDORA.DECISIONS", res], ["CREDORA.RANKING", res], ["CREDORA.RUN_LOG", S.runs.length]], lat(6, 15)),
  ];
}

/* ------------------------------ router ------------------------------ */

type Handler = (ctx: { u: User; body: Record<string, unknown>; q: URLSearchParams; m: RegExpExecArray }) => unknown;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/\{(\w+)\}/g, "([^/]+)")}$`), h]);

on("GET", "/api/me", ({ u }) => u);

on("GET", "/api/overview", ({ u }) => {
  // A relationship manager's counts cover only her assigned companies (V_RM_COMPANY, V_RM_DECISIONS).
  const all = u.role === "rm" ? world.all().filter((c) => assignedToMe(c.cif_id)) : world.all();
  const partners = all.reduce((a, c) => a + c.partner_count, 0);
  const run = officialRun();
  const pub = run ? wf().published[run.run_id] : null;
  let dm: DecisionMix | null = S.analysed && run ? mix() : null;
  if (dm && u.role === "rm") {
    const sc = scored().scored;
    dm = { APPROVE: 0, REFER: 0, DECLINE: 0 };
    for (const c of all) dm[sc[c.idx].decision]++;
  }
  const ov: Overview = {
    counts: {
      companies: all.length,
      partners,
      applications: all.length,
      accounts: u.role === "rm" ? all.length : all.length + Math.round(partners * 0.3),
    },
    last_generation: { seed: S.seed, generated_at: S.generated_at },
    last_analysis: run
      ? {
          run_id: run.run_id,
          finished_at: run.finished_at!,
          duration_ms: run.stages.reduce((a, s) => a + s.ms, 0),
          model_version: run.model_version,
          published_by: pub?.by ?? null,
          published_at: pub?.at ?? null,
        }
      : null,
    decision_mix: dm,
    sources: sources(),
  };
  return ov;
});

on("POST", "/api/admin/generate", ({ u, body }) => {
  need(u, ["admin"]);
  const seed = typeof body.seed === "number" ? body.seed : Math.floor(Math.random() * 90000000) + 10000000;
  const add = typeof body.companies === "number" ? body.companies : 1000;
  if (body.mode === "append") {
    if (!Number.isInteger(add) || add < 100 || add > 5000) throw new HttpError(422, "companies must be between 100 and 5000");
    audit(u, "GENERATE", `seed ${seed}`, `added ${num(add)} companies to the existing data`);
    const from = world.size;
    const steps = [
      { name: "prepare", ms: 900, detail: `${num(from)} companies kept, next ids C${String(from + 1).padStart(6, "0")}, A${String(from + 1).padStart(7, "0")}` },
      { name: "synthesize", ms: 1300, detail: `${num(add)} new companies, seed ${seed}` },
      { name: "oracle", ms: 2200, detail: `≈ ${num(add * 850)} transactions added` },
      { name: "mysql", ms: 800, detail: `${num(add)} companies and their partners added` },
      { name: "postgres", ms: 700, detail: `${num(add)} credit needs on file added, existing past loans and CRM kept` },
      { name: "mockdb", ms: 1500, detail: "CIBIL, GSTN and AA records added" },
      { name: "truth_export", ms: 300, detail: "truth kept in mockdb only" },
    ];
    return startJob("generate", steps, () => {
      // S.seed stays: it seeds every fixture company, so existing companies keep their data
      S.companies = from + add;
      S.generated_at = now();
      S.analysed = false;
      world = new World(world.seed, S.companies);
      scoredCache = null;
    });
  }
  audit(u, "GENERATE", `seed ${seed}`, "cleared and regenerated all data");
  const steps = [
    { name: "Clear Sapphire Bank databases (Oracle, MySQL, PostgreSQL)", ms: 1300, detail: "CBS, cif, los and crm truncated" },
    { name: "Clear mock CIBIL, GSTN and AA databases", ms: 900, detail: "3 databases cleared" },
    { name: "Clear Exasol results and staging", ms: 700, detail: "CREDORA_STAGE and results truncated" },
    { name: "Create 1,000 companies and their partners", ms: 1500, detail: `seed ${seed}` },
    { name: "Write customer master to MySQL", ms: 1100, detail: "1,000 companies, 3,5xx partners" },
    { name: "Write accounts and transactions to Oracle", ms: 2400, detail: "≈ 3.6 lakh transactions" },
    { name: "Write credit needs on file and past loans to PostgreSQL", ms: 1200, detail: "1,000 credit needs, 4,120 past loans" },
    { name: "Write CIBIL reports", ms: 1300, detail: "consumer and commercial" },
    { name: "Write GST registrations and filings", ms: 1600, detail: "2–10 years per company" },
    { name: "Write Account Aggregator accounts", ms: 1300, detail: "1–3 per partner, 12 months each" },
  ];
  return startJob("generate", steps, () => {
    S.seed = seed;
    S.companies = 1000;
    S.generated_at = now();
    S.analysed = false;
    S.offerPatches = {};
    S.events = [];
    // New companies under the old CIF ids: the relationship managers' books start empty.
    S.assignments = {};
    S.statusLog = [];
    world = new World(seed);
    scoredCache = null;
  });
});

on("GET", "/api/jobs/{id}", ({ m }) => {
  const j = jobs.get(decodeURIComponent(m[1]));
  if (!j) throw new HttpError(404, "Unknown job. Jobs are kept in memory and are lost when the page reloads in fixture mode.");
  return jobState(j);
});

on("GET", "/api/admin/sources", ({ u }) => {
  need(u, ["admin", "datasci"]);
  return sources();
});

on("GET", "/api/admin/audit", ({ u, q }) => {
  need(u, ["admin"]);
  return S.audit.slice(0, Number(q.get("limit") ?? 100));
});

on("GET", "/api/admin/purge-log", ({ u }) => {
  need(u, ["admin"]);
  const r = mulberry32(S.seed);
  const hex = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");
  const rows: PurgeEntry[] = [];
  const tables: [string, SourceId, number][] = [
    ["CREDORA_STAGE.CIBIL_RAW", "api.cibil", 4512],
    ["CREDORA_STAGE.GST_RAW", "api.gstn", 61234],
    ["CREDORA_STAGE.AA_RAW", "api.aa", 7020],
  ];
  for (let k = 0; k < 4; k++)
    for (const [t, src, n] of tables) {
      const at = new Date(Date.now() - (k * 15 + 3) * 60000 - 6 * 3600000 * k);
      rows.push({ purged_at: at.toISOString(), table_name: t, source: src, rows: Math.round(n * (0.9 + r() * 0.2)), sha256: hex(), purge_due: new Date(at.getTime() - 40000).toISOString() });
    }
  return rows;
});

on("GET", "/api/companies", ({ u, q }) => {
  const sc = S.analysed ? scored() : null;
  const term = (q.get("q") ?? "").trim().toLowerCase();
  const stage = q.get("stage");
  const decision = q.get("decision");
  const page = Math.max(1, Number(q.get("page") ?? 1));
  const size = Math.min(200, Math.max(1, Number(q.get("size") ?? 50)));
  let rows: CompanyRow[] = world.all().map((c) => {
    const s = sc?.scored[c.idx];
    return {
      cif_id: c.cif_id,
      legal_name: c.legal_name,
      industry: c.industry,
      city: c.city,
      stage: c.stage,
      partners: c.partner_count,
      rm_id: c.rm_id,
      decision: s?.decision ?? null,
      rank_no: sc ? sc.ranks[c.idx] : null,
      offer_amount: s && s.decision !== "DECLINE" ? s.amount : null,
    };
  });
  // Exasol returns only the companies assigned to CREDORA_RM (V_RM_COMPANY).
  if (u.role === "rm") rows = rows.filter((r) => assignedToMe(r.cif_id)).map((r) => ({ ...r, rm_id: DEMO_RM }));
  if (term) rows = rows.filter((r) => r.legal_name.toLowerCase().includes(term) || r.cif_id.toLowerCase().includes(term) || r.city.toLowerCase().includes(term));
  if (stage) rows = rows.filter((r) => r.stage === stage);
  if (decision) rows = rows.filter((r) => r.decision === decision);
  return { items: rows.slice((page - 1) * size, page * size), total: rows.length, page, size };
});

on("GET", "/api/companies/{cif}/tree", ({ u, m }) => {
  const c = companyFor(u, m[1]);
  audit(u, "VIEW_TREE", c.cif_id);
  return tree(u, c);
});

on("GET", "/api/nodes/{id}", ({ u, m }) => {
  const id = decodeURIComponent(m[1]);
  return node(u, id);
});

on("GET", "/api/companies/{cif}/report", ({ u, m }) => {
  need(u, ["admin", "datasci", "loanops", "rm"]);
  const c = companyFor(u, m[1]);
  audit(u, "VIEW_REPORT", c.cif_id, "Exasol report");
  return report(c, u);
});

on("POST", "/api/analysis/run", ({ u }) => {
  need(u, ["datasci"]); // the run is a draft until the data scientist publishes it
  const d = new Date();
  const run_id = `R${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(S.runs.length + 1).padStart(2, "0")}`;
  audit(u, "RUN_ANALYSIS", run_id, `${num(world.size)} companies`);
  const steps = RUN_STAGES.map((name, i) => ({ name, ms: Math.round(STAGE_MS[i] / 9), detail: `${(STAGE_MS[i] / 1000).toFixed(1)} s in Exasol` }));
  steps[1].detail = "4,5xx CIBIL calls, 32 in parallel";
  steps[9].detail = "Draft run. Offers go to the CRM when it is published.";
  const started = now();
  return startJob("analysis", steps, () => {
    S.analysed = true;
    scoredCache = null;
    const m = mix();
    S.runs.push({
      ...mkRun(run_id, started, activeModel().version, null),
      started_by: u.username,
      approve: m.APPROVE,
      refer: m.REFER,
      decline: m.DECLINE,
    });
  });
});

on("GET", "/api/runs", ({ u }) => {
  need(u, ["admin", "datasci", "loanops"]);
  const m = S.analysed ? mix() : null;
  const pub = wf().published;
  return S.runs
    .map((r, i) => (i === S.runs.length - 1 && m ? { ...r, approve: m.APPROVE, refer: m.REFER, decline: m.DECLINE } : r))
    .map((r) => ({
      ...r,
      published: !!pub[r.run_id],
      published_by: pub[r.run_id]?.by ?? null,
      published_at: pub[r.run_id]?.at ?? null,
      publish_note: pub[r.run_id]?.note ?? null,
    }))
    .filter((r) => r.published || u.role !== "loanops") // loan operations sees published runs only
    .slice()
    .reverse();
});

on("POST", "/api/runs/{id}/publish", ({ u, m, body }) => {
  need(u, ["datasci"]);
  const id = decodeURIComponent(m[1]);
  const r = S.runs.find((x) => x.run_id === id);
  if (!r) throw new HttpError(404, `No analysis run ${id}.`);
  if (r.status !== "done") throw new HttpError(409, `Run ${id} is ${r.status}. Only a finished run can be published.`);
  if (wf().published[id]) throw new HttpError(409, `Run ${id} is already published.`);
  const note = String(body.note ?? "").trim() || null;
  wf().published[id] = { by: u.username, at: now(), note };
  audit(u, "RUN_PUBLISH", id, note ?? "published to loan operations");
  return { run_id: id, published: true, published_by: u.username, note };
});

on("GET", "/api/decisions", ({ u, q }) => {
  need(u, ["admin", "datasci", "loanops"]);
  if (!S.analysed || !officialRun()) return { items: [], total: 0, page: 1, size: 50 };
  const { scored: sc, ranks } = scored();
  let rows: DecisionRow[] = world.all().map((c) => {
    const s = sc[c.idx];
    return {
      cif_id: c.cif_id,
      legal_name: c.legal_name,
      decision: s.decision,
      grade: s.grade,
      pd: s.pd,
      rank_no: ranks[c.idx],
      offer_amount: s.decision === "DECLINE" ? null : s.amount,
      offer_roi: s.decision === "DECLINE" ? null : s.roi,
      offer_tenure: s.decision === "DECLINE" ? null : s.tenure,
      raroc: s.raroc,
      assigned_rm_id: wf().assignments[c.cif_id]?.rm_id ?? null,
    };
  });
  const d = q.get("decision");
  const g = q.get("grade");
  const a = q.get("assigned");
  if (d) rows = rows.filter((r) => r.decision === d);
  if (g) rows = rows.filter((r) => r.grade === g);
  if (a === "yes") rows = rows.filter((r) => r.assigned_rm_id);
  if (a === "no") rows = rows.filter((r) => !r.assigned_rm_id);
  rows.sort((a, b) => a.rank_no - b.rank_no);
  const page = Math.max(1, Number(q.get("page") ?? 1));
  const size = 50;
  return { items: rows.slice((page - 1) * size, page * size), total: rows.length, page, size };
});

on("GET", "/api/top50", ({ u, q }) => {
  need(u, ["admin", "datasci", "loanops"]);
  const rid = q.get("run_id");
  if (rid && u.role === "loanops" && !wf().published[rid]) throw new HttpError(404, `Analysis run ${rid} is not published.`);
  if (!S.analysed || !officialRun()) return [];
  const { scored: sc, ranks } = scored();
  const rows: Top50Row[] = [];
  for (const c of world.all()) {
    const rk = ranks[c.idx];
    if (rk > 50) continue;
    const s = sc[c.idx];
    rows.push({
      rank_no: rk,
      cif_id: c.cif_id,
      legal_name: c.legal_name,
      industry: c.industry,
      grade: s.grade,
      pd: s.pd,
      raroc: s.raroc,
      offer_amount: s.amount,
      stage: offerById(c.idx + 1)?.stage ?? null,
      assigned_rm_id: wf().assignments[c.cif_id]?.rm_id ?? null,
    });
  }
  return rows.sort((a, b) => a.rank_no - b.rank_no);
});

on("POST", "/api/ml/train", ({ u }) => {
  need(u, ["datasci"]);
  const nums = S.models.map((m) => Number(m.version.match(/^pd-v(\d+)$/)?.[1] ?? 0));
  const next = `pd-v${Math.max(0, ...nums) + 1}`;
  audit(u, "TRAIN_MODEL", next, "CREDORA.TRAIN_MODEL on los.past_loan");
  return startJob(
    "train",
    [
      { name: "Read past loans from PostgreSQL (VS_LOS.past_loan_training)", ms: 900, detail: "4,120 past loans, 9.8% defaulted" },
      { name: "Train the champion, gradient-boosted trees in a Python UDF (CREDORA.TRAIN_PD)", ms: 3200, detail: "AUC 0.824 · Gini 0.648 on hold-out" },
      { name: "Train the challenger, a logistic regression scorecard (CREDORA.TRAIN_SCORECARD)", ms: 900, detail: "AUC 0.829 · Gini 0.658 on the same hold-out" },
      {
        name: "Save both to BucketFS and register them (CREDORA.MODEL_REGISTRY). Activation needs the admin's approval.",
        ms: 700,
        detail: `${next} and ${next}-lr registered inactive. ${activeModel().version} stays active until the admin approves an activation request.`,
      },
      { name: "Shadow-score the latest run with the challenger (CREDORA.SCORE_CHALLENGER)", ms: 1600, detail: "1,000 companies scored in the shadow" },
    ],
    () => {
      const bump = (m: Model): Model => {
        const auc = Math.round((m.auc + 0.006 + Math.random() * 0.01) * 1000) / 1000;
        return {
          ...m,
          trained_at: now(),
          trained_by: u.username,
          auc,
          gini: Math.round((2 * auc - 1) * 1000) / 1000,
          active: false,
          feature_importance: m.feature_importance.map((f) => ({ ...f, importance: Math.round(f.importance * (0.9 + Math.random() * 0.2) * 1000) / 1000 })),
        };
      };
      const trees = [...S.models].reverse().find((m) => !isScorecard(m))!;
      const card = [...S.models].reverse().find(isScorecard) ?? initialModels().filter(isScorecard)[1];
      // Registered inactive: a model decides only after the admin approves its activation request.
      S.models.push({ ...bump(trees), version: next, active: false }, { ...bump(card), version: `${next}-lr` });
      scoredCache = null;
    },
  );
});

on("GET", "/api/ml/models", ({ u }) => {
  need(u, ["admin", "datasci"]);
  const ch = challengerOf(S.models);
  return S.models
    .slice()
    .reverse()
    .map((m) => ({ ...m, role: m.active ? "champion" : m === ch ? "challenger" : null, kind: isScorecard(m) ? "coefficient" : "importance" }));
});

on("GET", "/api/ml/compare", ({ u }) => {
  need(u, ["admin", "datasci"]);
  const champ = activeModel();
  const ch = challengerOf(S.models);
  const card = (m: Model) => ({
    version: m.version,
    algorithm: m.algorithm,
    active: m.active,
    auc: m.auc,
    gini: m.gini,
    kind: isScorecard(m) ? ("coefficient" as const) : ("importance" as const),
    top: [...m.feature_importance].sort((a, b) => Math.abs(b.importance) - Math.abs(a.importance)).slice(0, 5),
  });
  const run = lastRun();
  const out: ModelComparison = {
    run_id: run?.run_id ?? null,
    active_version: champ.version,
    champion: card(champ),
    challenger: ch ? card(ch) : null,
    same_holdout: !!ch && ch.version.replace(/-lr$/, "") === champ.version.replace(/-lr$/, ""),
    scored: !!(run && ch),
    companies: 0,
    grades_changed: 0,
    decisions_changed: 0,
    champion_mean_pd: null,
    challenger_mean_pd: null,
    transitions: [],
    changed: [],
  };
  if (!run || !ch) return out;
  const today = scored().scored;
  const moves = new Map<string, number>();
  const changed: ModelComparison["changed"] = [];
  let pdA = 0;
  let pdB = 0;
  for (const c of world.all()) {
    const a = today[c.idx];
    const b = score(world, c, modelBias(ch));
    out.companies++;
    pdA += a.pd;
    pdB += b.pd;
    if (a.grade !== b.grade) out.grades_changed++;
    if (a.decision !== b.decision) {
      out.decisions_changed++;
      const k = `${a.decision}>${b.decision}`;
      moves.set(k, (moves.get(k) ?? 0) + 1);
      changed.push({ cif_id: c.cif_id, legal_name: c.legal_name, from: a.decision, to: b.decision, champion_pd: a.pd, challenger_pd: b.pd, champion_grade: a.grade, challenger_grade: b.grade });
    }
  }
  out.champion_mean_pd = pdA / Math.max(1, out.companies);
  out.challenger_mean_pd = pdB / Math.max(1, out.companies);
  out.transitions = [...moves].map(([k, n]) => ({ from: k.split(">")[0] as ModelComparison["transitions"][0]["from"], to: k.split(">")[1] as ModelComparison["transitions"][0]["to"], n })).sort((x, y) => y.n - x.n);
  out.changed = changed.sort((x, y) => Math.abs(y.challenger_pd - y.champion_pd) - Math.abs(x.challenger_pd - x.champion_pd)).slice(0, 8);
  return out;
});

/* ------------------------------ hand-offs between the roles ------------------------------ */

type WF = Required<Pick<Persisted, "published" | "assignments" | "statusLog" | "activations">>;

/** Workflow state, created on first use (also for fixture state saved before it existed). */
function wf(): WF {
  if (!S.published) S.published = Object.fromEntries(S.runs.map((r) => [r.run_id, { by: "datasci", at: r.finished_at ?? r.started_at, note: null }]));
  if (!S.activations) S.activations = [];
  if (!S.assignments || !S.statusLog) seedBook();
  return S as unknown as WF;
}

/** Demo book: 25 of the best pre-approved Top 50 companies for RM001, some more for other managers, a few status updates. */
function seedBook() {
  S.assignments = {};
  S.statusLog = [];
  if (!S.analysed) return;
  const { scored: sc, ranks } = scored();
  const ranked = world
    .all()
    .filter((c) => sc[c.idx].decision !== "DECLINE")
    .sort((a, b) => ranks[a.idx] - ranks[b.idx]);
  const top = ranked.filter((c) => ranks[c.idx] <= 50 && sc[c.idx].decision === "APPROVE").slice(0, 25);
  const others = ranked.filter((c) => !top.includes(c)).slice(0, 18);
  let ev = 1;
  const log = (cif: string, rm: string, status: LoanStatus, note: string, actor: string, at: string) =>
    S.statusLog!.push({ event_id: ev++, cif_id: cif, rm_id: rm, status, note, actor, at });
  top.forEach((c, i) => {
    const at = minsAgo(60 * 20 - i);
    S.assignments![c.cif_id] = { rm_id: DEMO_RM, assigned_by: "seed", assigned_at: at };
    log(c.cif_id, DEMO_RM, "ASSIGNED", `Assigned to ${DEMO_RM}`, "seed", at);
  });
  const steps: [LoanStatus, string][] = [
    ["CONTACTED", "Called the CFO and shared the pre-approved offer."],
    ["NEGOTIATING", "Customer wants a longer tenure, within the limit."],
    ["LOAN_TAKEN", "Customer accepted the offer. Documents collected."],
  ];
  top.slice(0, 6).forEach((c, i) =>
    steps.slice(0, 1 + (i % 3)).forEach(([s, n], k) => log(c.cif_id, DEMO_RM, s, n, "rm", minsAgo(60 * 6 - i * 20 - k * 30))),
  );
  others.forEach((c, i) => {
    const rm = RMS[1 + (i % 5)].rm_id;
    const at = minsAgo(60 * 19 - i);
    S.assignments![c.cif_id] = { rm_id: rm, assigned_by: "loanops", assigned_at: at };
    log(c.cif_id, rm, "ASSIGNED", `Assigned to ${rm}`, "loanops", at);
    const st: LoanStatus[] = ["CONTACTED", "NEGOTIATING", "IN_PROGRESS", "DISBURSED", "NOT_INTERESTED"];
    if (i % 3 !== 2) log(c.cif_id, rm, st[i % st.length], "Logged by the relationship manager.", "rm", minsAgo(60 * 4 - i * 7));
  });
}

function assignedToMe(cif: string) {
  return wf().assignments[cif]?.rm_id === DEMO_RM;
}

/** The latest published run: what loan operations and relationship managers see. */
function officialRun(): Run | null {
  if (!S.analysed) return null;
  const pub = wf().published;
  return [...S.runs].reverse().find((r) => pub[r.run_id]) ?? null;
}

function historyOf(cif: string): LoanStatusEvent[] {
  return wf()
    .statusLog.filter((e) => e.cif_id === cif)
    .sort((a, b) => b.at.localeCompare(a.at) || b.event_id - a.event_id);
}

const RM_STATUSES: LoanStatus[] = ["CONTACTED", "NEGOTIATING", "LOAN_TAKEN", "IN_PROGRESS", "DISBURSED", "NOT_INTERESTED"];
/* Mirrors backend app/rmbook.py: NEXT, NEEDS_AGREED_OFFER and offer_block. */
const NEXT: Record<LoanStatus, LoanStatus[]> = {
  ASSIGNED: ["CONTACTED", "NOT_INTERESTED"],
  CONTACTED: ["NEGOTIATING", "NOT_INTERESTED"],
  NEGOTIATING: ["LOAN_TAKEN", "NOT_INTERESTED"],
  LOAN_TAKEN: ["IN_PROGRESS", "NOT_INTERESTED"],
  IN_PROGRESS: ["DISBURSED", "NOT_INTERESTED"],
  NOT_INTERESTED: ["CONTACTED"],
  DISBURSED: [],
};
const NEEDS_AGREED: LoanStatus[] = ["LOAN_TAKEN", "IN_PROGRESS", "DISBURSED"];
const offerOfCif = (cif: string): Offer | null => {
  const c = world.byCif(cif);
  return c ? offerById(c.idx + 1) : null;
};
function offerBlock(o: Offer | null): string | null {
  if (!o) return "There is no pre-approved offer for this company in the CRM.";
  if (o.stage === "SANCTIONED") return null;
  if (o.stage === "DECLINED") return "The pre-approved offer is declined, so the customer cannot take the loan.";
  if (o.stage === "OFFERED" || o.agreed_amount == null) return "No terms are agreed yet. Agree the terms on the offer screen first.";
  const within =
    (o.agreed_amount ?? 0) <= (o.max_amount ?? 0) && (o.agreed_roi ?? 0) >= (o.floor_roi ?? 0) && (o.agreed_tenure ?? 0) <= (o.max_tenure ?? 0);
  if (o.stage === "ESCALATED" || (o.stage === "VERIFIED" && !within))
    return "The agreed terms are above the negotiation limits. Loan operations must sanction them first.";
  return null;
}
const nextStatuses = (cur: LoanStatus, block: string | null) => NEXT[cur].filter((s) => !(block && NEEDS_AGREED.includes(s)));

on("GET", "/api/rms", ({ u }) => {
  need(u, ["admin", "datasci", "loanops"]);
  const n: Record<string, number> = {};
  for (const a of Object.values(wf().assignments)) n[a.rm_id] = (n[a.rm_id] ?? 0) + 1;
  return RMS.map((r) => ({ ...r, assigned: n[r.rm_id] ?? 0 }));
});

on("GET", "/api/assignments", ({ u }) => {
  return Object.entries(wf().assignments)
    .filter(([, a]) => u.role !== "rm" || a.rm_id === DEMO_RM)
    .map(([cif_id, a]) => ({ cif_id, ...a }));
});

on("POST", "/api/assignments", ({ u, body }) => {
  need(u, ["loanops"]);
  if (!officialRun()) throw new HttpError(409, "No published analysis run yet. The data scientist publishes one first.");
  const rm = String(body.rm_id ?? "").toUpperCase();
  if (!RMS.some((r) => r.rm_id === rm)) throw new HttpError(422, `No relationship manager ${rm} in the customer master.`);
  const cifs = [...new Set(((body.cif_ids as string[]) ?? []).map((c) => String(c).toUpperCase()))];
  if (!cifs.length) throw new HttpError(422, "Choose at least one company.");
  const missing = cifs.filter((c) => !world.byCif(c));
  if (missing.length) throw new HttpError(404, `Not in the published run (${missing.slice(0, 5).join(", ")}).`);
  const out = { rm_id: rm, assigned: 0, moved: 0, unchanged: 0 };
  const w = wf();
  for (const c of cifs) {
    const prev = w.assignments[c]?.rm_id;
    if (prev === rm) {
      out.unchanged++;
      continue;
    }
    if (prev) out.moved++;
    else out.assigned++;
    w.assignments[c] = { rm_id: rm, assigned_by: u.username, assigned_at: now() };
    w.statusLog.push({ event_id: w.statusLog.length + 1, cif_id: c, rm_id: rm, status: "ASSIGNED", note: `Assigned to ${rm}${prev ? ` (was ${prev})` : ""}`, actor: u.username, at: now() });
  }
  audit(u, "ASSIGN_RM", rm, `${cifs.length} companies (${out.assigned} new, ${out.moved} moved): ${cifs.slice(0, 20).join(", ")}`);
  return out;
});

on("GET", "/api/loan-status", ({ u }) => {
  const sc = S.analysed ? scored() : null;
  const names = Object.fromEntries(RMS.map((r) => [r.rm_id, r.name]));
  const rows: LoanStatusRow[] = Object.entries(wf().assignments)
    .filter(([, a]) => u.role !== "rm" || a.rm_id === DEMO_RM)
    .map(([cif, a]) => {
      const c = world.byCif(cif);
      const s = c && sc ? sc.scored[c.idx] : null;
      const h = historyOf(cif);
      const last = h[0];
      const o = offerOfCif(cif);
      const block = offerBlock(o);
      const cur = last?.status ?? "ASSIGNED";
      return {
        cif_id: cif,
        legal_name: c?.legal_name ?? "",
        rm_id: a.rm_id,
        rm_name: names[a.rm_id] ?? a.rm_id,
        assigned_by: a.assigned_by,
        assigned_at: a.assigned_at,
        decision: s?.decision ?? null,
        rank_no: c && sc ? sc.ranks[c.idx] : null,
        offer_amount: s && s.decision !== "DECLINE" ? s.amount : null,
        status: last?.status ?? "ASSIGNED",
        note: last?.note ?? null,
        updated_at: last?.at ?? a.assigned_at,
        updated_by: last?.actor ?? a.assigned_by,
        history: h,
        offer_id: o?.offer_id ?? null,
        offer_stage: o?.stage ?? null,
        offer_block: cur === "DISBURSED" ? null : block,
        next_statuses: nextStatuses(cur, block),
      };
    });
  return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
});

on("POST", "/api/loan-status/{cif}", ({ u, m, body }) => {
  need(u, ["rm"]);
  const cif = decodeURIComponent(m[1]).toUpperCase();
  if (!assignedToMe(cif)) throw new HttpError(403, `${cif} is not assigned to you.`);
  const status = String(body.status ?? "").toUpperCase() as LoanStatus;
  const note = String(body.note ?? "").trim();
  if (!RM_STATUSES.includes(status)) throw new HttpError(422, `status must be one of ${RM_STATUSES.join(", ")}`);
  if (!note) throw new HttpError(422, "A note is required.");
  const cur = historyOf(cif)[0]?.status;
  if (cur === "DISBURSED") throw new HttpError(409, "The loan is disbursed, so its status no longer changes.");
  if (cur === status) throw new HttpError(409, "The status is already that.");
  const from = cur ?? "ASSIGNED";
  if (!NEXT[from].includes(status)) throw new HttpError(409, `${from} can move only to ${NEXT[from].join(" or ") || "nothing"}.`);
  const block = NEEDS_AGREED.includes(status) ? offerBlock(offerOfCif(cif)) : null;
  if (block) throw new HttpError(409, `${status} needs agreed terms. ${block}`);
  const w = wf();
  const e: LoanStatusEvent = { event_id: w.statusLog.length + 1, cif_id: cif, rm_id: DEMO_RM, status, note, actor: u.username, at: now() };
  w.statusLog.push(e);
  audit(u, "LOAN_STATUS", cif, `${status}: ${note}`);
  return e;
});

/* risk-model activation: datasci requests, admin decides (crm.model_activation_request) */

const ACTIVATION_CHANGED = "Active model changed since this request. Send a new activation request.";
const card = (m: Model | undefined) => (m ? { version: m.version, algorithm: m.algorithm, auc: m.auc, gini: m.gini } : null);

on("GET", "/api/ml/activation-requests", ({ u }) => {
  need(u, ["admin", "datasci"]);
  const active = activeModel().version;
  return wf()
    .activations.filter((r) => u.role === "admin" || r.created_by === u.username)
    .map((r) => (r.status === "PENDING" ? { ...r, baseline_changed: r.current_version !== active } : r))
    .sort((a, b) => Number(b.status === "PENDING") - Number(a.status === "PENDING") || b.created_at.localeCompare(a.created_at));
});

on("POST", "/api/ml/activation-requests", ({ u, body }) => {
  need(u, ["datasci"]);
  const note = String(body.note ?? "").trim();
  if (!note) throw new HttpError(422, "A note is required.");
  const v = String(body.version ?? "");
  const m = S.models.find((x) => x.version === v);
  if (!m) throw new HttpError(404, `No model ${v} in CREDORA.MODEL_REGISTRY.`);
  if (m.active) throw new HttpError(409, `Model ${v} is already active.`);
  const w = wf();
  if (w.activations.some((r) => r.model_version === v && r.status === "PENDING")) throw new HttpError(409, `Model ${v} already has a pending activation request.`);
  const cur = S.models.find((x) => x.active);
  const r: ActivationRequest = {
    request_id: w.activations.length + 1,
    created_at: now(),
    created_by: u.username,
    model_version: v,
    current_version: cur?.version ?? null,
    metrics: { candidate: card(m), current: card(cur) },
    note,
    status: "PENDING",
    decided_by: null,
    decided_at: null,
    decision_note: null,
  };
  w.activations.push(r);
  audit(u, "MODEL_ACTIVATION_REQUEST", v, note);
  return r;
});

function pendingActivation(u: User, id: string, body: Record<string, unknown>) {
  const r = wf().activations.find((x) => x.request_id === Number(id));
  if (!r) throw new HttpError(404, `No activation request ${id}.`);
  if (r.status !== "PENDING") throw new HttpError(409, `Request ${r.request_id} is ${r.status.toLowerCase()} and read-only.`);
  if (r.created_by === u.username) throw new HttpError(403, "You cannot approve or reject your own request.");
  const note = String(body.note ?? "").trim();
  if (!note) throw new HttpError(422, "A decision note is required.");
  return { r, note };
}

on("POST", "/api/ml/activation-requests/{id}/approve", ({ u, m, body }) => {
  need(u, ["admin"]);
  const { r, note } = pendingActivation(u, m[1], body);
  if (r.current_version !== (S.models.find((x) => x.active)?.version ?? null)) throw new HttpError(409, ACTIVATION_CHANGED);
  Object.assign(r, { status: "APPROVED", decided_by: u.username, decided_at: now(), decision_note: note });
  S.models.forEach((x) => (x.active = x.version === r.model_version));
  scoredCache = null;
  audit(u, "MODEL_ACTIVATION_APPROVE", r.model_version, note);
  return r;
});

on("POST", "/api/ml/activation-requests/{id}/reject", ({ u, m, body }) => {
  need(u, ["admin"]);
  const { r, note } = pendingActivation(u, m[1], body);
  Object.assign(r, { status: "REJECTED", decided_by: u.username, decided_at: now(), decision_note: note });
  audit(u, "MODEL_ACTIVATION_REJECT", r.model_version, note);
  return r;
});

on("GET", "/api/approvals/pending", ({ u }) => {
  need(u, ["admin"]);
  return {
    policy: (S.proposals ?? []).filter((p) => p.status === "PENDING").length,
    models: wf().activations.filter((r) => r.status === "PENDING").length,
  };
});

function whatIf(body: Record<string, unknown>): WhatIfResult {
  const base = currentPolicy();
  const p: Policy = {
    hurdle_pct: Number(body.hurdle_pct ?? base.hurdle_pct),
    eblr_pct: Number(body.eblr_pct ?? base.eblr_pct),
    max_gst_share_pct: Number(body.max_gst_share_pct ?? base.max_gst_share_pct),
  };
  const t0 = performance.now();
  const before: DecisionMix = { APPROVE: 0, REFER: 0, DECLINE: 0 };
  const after: DecisionMix = { APPROVE: 0, REFER: 0, DECLINE: 0 };
  let before_amount = 0;
  let after_amount = 0;
  const cur = scored().scored;
  for (const c of world.all()) {
    const b = cur[c.idx];
    const a = score(world, c, modelBias(), p);
    before[b.decision]++;
    after[a.decision]++;
    if (b.decision === "APPROVE") before_amount += b.amount;
    if (a.decision === "APPROVE") after_amount += a.amount;
  }
  return {
    params: p,
    baseline: { ...base },
    before,
    after,
    before_amount,
    after_amount,
    run_id: lastRun()?.run_id ?? "",
    model_version: activeModel().version,
    ms: Math.round(380 + (performance.now() - t0)),
  };
}

on("POST", "/api/whatif", ({ u, body }) => {
  need(u, ["datasci"]);
  const res = whatIf(body);
  const p = res.params;
  audit(u, "WHAT_IF", "policy", `hurdle ${p.hurdle_pct}%, EBLR ${p.eblr_pct}%, GST share ${p.max_gst_share_pct}%`);
  return res;
});

/* ------------------------------ policy maker-checker ------------------------------ */

const POLICY_KEYS: Record<keyof Policy, [string, string]> = {
  hurdle_pct: ["HURDLE_PCT", "RAROC hurdle"],
  eblr_pct: ["EBLR_PCT", "EBLR"],
  max_gst_share_pct: ["MAX_GST_SHARE_PCT", "Maximum share of GST turnover"],
};
const POLICY_CHANGED = "Policy changed since this proposal. Start a new what-if run.";
const sameVal = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const changeText = (ls: PolicyLeverChange[]) => ls.map((l) => `${l.key} ${l.old} → ${l.new}`).join("; ");
const staleLevers = (ls: PolicyLeverChange[]) => ls.filter((l) => !sameVal(currentPolicy()[l.lever as keyof Policy], l.old));

function analysisRunning() {
  return [...jobs.values()].some((j) => j.kind === "analysis" && !j.applied && Date.now() - j.started < j.steps.reduce((a, s) => a + s.ms, 0));
}

function runView(r: WhatIfRun): WhatIfRun {
  const p = (S.proposals ?? []).filter((x) => x.run_id === r.run_id).sort((a, b) => b.proposal_id - a.proposal_id)[0];
  return { ...r, proposal: p ? { proposal_id: p.proposal_id, status: p.status } : null };
}

on("GET", "/api/whatif/runs", ({ u }) => {
  need(u, ["datasci"]);
  return (S.whatifRuns ?? []).slice().reverse().map(runView);
});

on("POST", "/api/whatif/runs", ({ u, body }) => {
  need(u, ["datasci"]);
  const res = whatIf(body);
  S.whatifRuns ??= [];
  const run: WhatIfRun = {
    run_id: `W${String(S.whatifRuns.length + 1).padStart(4, "0")}`,
    created_at: now(),
    created_by: u.username,
    base_run_id: res.run_id ?? "",
    model_version: res.model_version ?? "",
    levers: res.params,
    baseline: res.baseline,
    before: res.before,
    after: res.after,
    before_amount: res.before_amount ?? null,
    after_amount: res.after_amount ?? null,
    ms: res.ms ?? null,
    proposal: null,
  };
  S.whatifRuns.push(run);
  const p = run.levers;
  audit(u, "WHAT_IF_RUN", run.run_id, `hurdle ${p.hurdle_pct}%, EBLR ${p.eblr_pct}%, GST share ${p.max_gst_share_pct}% on ${run.base_run_id}`);
  return run;
});

on("GET", "/api/policy/proposals", ({ u }) => {
  need(u, ["admin", "datasci"]);
  const list = (S.proposals ?? []).filter((p) => u.role === "admin" || p.created_by === u.username);
  return list
    .map((p) => (p.status === "PENDING" ? { ...p, baseline_changed: staleLevers(p.levers).length > 0 } : p))
    .sort((a, b) => Number(b.status === "PENDING") - Number(a.status === "PENDING") || b.created_at.localeCompare(a.created_at));
});

on("POST", "/api/policy/proposals", ({ u, body }) => {
  need(u, ["datasci"]);
  const note = String(body.note ?? "").trim();
  if (!note) throw new HttpError(422, "A note is required.");
  const run = (S.whatifRuns ?? []).find((r) => r.run_id === String(body.run_id ?? ""));
  if (!run) throw new HttpError(404, `No what-if run ${String(body.run_id)}.`);
  const levers: PolicyLeverChange[] = (Object.keys(POLICY_KEYS) as (keyof Policy)[])
    .filter((k) => !sameVal(run.levers[k], run.baseline[k]))
    .map((k) => ({ key: POLICY_KEYS[k][0], lever: k, label: POLICY_KEYS[k][1], old: run.baseline[k], new: run.levers[k] }));
  if (!levers.length) throw new HttpError(409, `What-if run ${run.run_id} uses the current policy. There is nothing to propose.`);
  if (staleLevers(levers).length) throw new HttpError(409, "Policy changed since this what-if run. Run it again with the current policy.");
  S.proposals ??= [];
  if (S.proposals.some((p) => p.run_id === run.run_id && p.status === "PENDING"))
    throw new HttpError(409, `What-if run ${run.run_id} already has a pending proposal.`);
  const p: PolicyProposal = {
    proposal_id: S.proposals.length + 1,
    created_at: now(),
    created_by: u.username,
    run_id: run.run_id,
    levers,
    outcome: {
      base_run_id: run.base_run_id,
      current: { ...run.before, amount: run.before_amount },
      proposed: { ...run.after, amount: run.after_amount },
    },
    note,
    status: "PENDING",
    decided_by: null,
    decided_at: null,
    decision_note: null,
    applied_run_id: null,
  };
  S.proposals.push(p);
  audit(u, "POLICY_PROPOSE", `proposal ${p.proposal_id}`, `${run.run_id}: ${changeText(levers)}. ${note}`);
  return p;
});

function pendingProposal(u: User, id: string, body: Record<string, unknown>) {
  const p = (S.proposals ?? []).find((x) => x.proposal_id === Number(id));
  if (!p) throw new HttpError(404, `No proposal ${id}.`);
  if (p.status !== "PENDING") throw new HttpError(409, `Proposal ${p.proposal_id} is ${p.status.toLowerCase()} and read-only.`);
  if (p.created_by === u.username) throw new HttpError(403, "You cannot approve or reject your own proposal.");
  const note = String(body.note ?? "").trim();
  if (!note) throw new HttpError(422, "A decision note is required.");
  return { p, note };
}

on("POST", "/api/policy/proposals/{id}/approve", ({ u, m, body }) => {
  need(u, ["admin"]);
  const { p, note } = pendingProposal(u, m[1], body);
  if (staleLevers(p.levers).length) throw new HttpError(409, POLICY_CHANGED);
  if (analysisRunning()) throw new HttpError(409, "An analysis job is still running.");
  const d = new Date();
  const run_id = `R${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(S.runs.length + 1).padStart(2, "0")}`;
  Object.assign(p, { status: "APPROVED", decided_by: u.username, decided_at: now(), decision_note: note, applied_run_id: run_id });
  audit(u, "POLICY_APPROVE", `proposal ${p.proposal_id}`, `${changeText(p.levers)}. ${note}`);
  audit(u, "POLICY_APPLY", "CREDORA.CONFIG", `proposal ${p.proposal_id}: ${changeText(p.levers)}`);
  audit(u, "RUN_ANALYSIS", run_id, `CREDORA.RUN_ANALYSIS after policy proposal ${p.proposal_id}`);
  const steps = [
    { name: "Write the approved policy to CREDORA.CONFIG (as CREDORA_SVC)", ms: 500, detail: changeText(p.levers) },
    ...RUN_STAGES.map((name, i) => ({ name, ms: Math.round(STAGE_MS[i] / 9), detail: `${(STAGE_MS[i] / 1000).toFixed(1)} s in Exasol` })),
  ];
  steps[steps.length - 1].detail = "offers written to crm.offer";
  const started = now();
  const next: Policy = { ...currentPolicy() };
  for (const l of p.levers) next[l.lever as keyof Policy] = l.new;
  const job = startJob("analysis", steps, () => {
    S.policy = next;
    S.analysed = true;
    scoredCache = null;
    const mx = mix();
    S.runs.push({ ...mkRun(run_id, started, activeModel().version, null), started_by: u.username, approve: mx.APPROVE, refer: mx.REFER, decline: mx.DECLINE });
    // The admin approved the policy, so the run is official at once: published by the system on the admin's behalf.
    const pubNote = `Policy proposal ${p.proposal_id} approved by ${u.username}`;
    wf().published[run_id] = { by: "system", at: now(), note: pubNote };
    S.audit.unshift({ at: now(), username: "system", role: u.role, action: "RUN_PUBLISH", target: run_id, detail: `${pubNote}, published by the system on behalf of ${u.username}` });
    save();
  });
  return { job_id: job.job_id, run_id, proposal: p };
});

on("POST", "/api/policy/proposals/{id}/reject", ({ u, m, body }) => {
  need(u, ["admin"]);
  const { p, note } = pendingProposal(u, m[1], body);
  Object.assign(p, { status: "REJECTED", decided_by: u.username, decided_at: now(), decision_note: note });
  audit(u, "POLICY_REJECT", `proposal ${p.proposal_id}`, note);
  return p;
});

on("GET", "/api/offers", ({ u, q }) => {
  need(u, ["rm", "loanops", "admin"]);
  let rows = allOffers();
  if (u.role === "rm") rows = rows.filter((o) => assignedToMe(o.cif_id)); // her assigned companies only
  const st = q.get("stage");
  if (st) {
    const set = st.split(",");
    rows = rows.filter((o) => set.includes(o.stage));
  }
  return rows.sort((a, b) => (a.rank_no ?? 9999) - (b.rank_no ?? 9999));
});

function offerFor(u: User, id: string): Offer {
  const o = offerById(Number(id));
  if (!o) throw new HttpError(404, `No offer ${id}.`);
  if (u.role === "rm" && !assignedToMe(o.cif_id)) throw new HttpError(403, "This offer is not assigned to you.");
  return o;
}

function quote(o: Offer, amount: number, roi: number, tenure: number) {
  const reasons: string[] = [];
  if (amount > (o.max_amount ?? 0)) reasons.push(`Amount is above the maximum of ${fmtCr(o.max_amount ?? 0)}.`);
  if (roi < (o.floor_roi ?? 0)) reasons.push(`ROI is below the floor of ${(o.floor_roi ?? 0).toFixed(2)}%.`);
  if (tenure > (o.max_tenure ?? 0)) reasons.push(`Tenure is longer than the maximum of ${o.max_tenure} months.`);
  const pol = currentPolicy();
  const raroc = Math.round(rarocOf(roi, (o.pd ?? 0.02) * (1 + Math.max(0, tenure - (o.offer_tenure ?? tenure)) / 240), pol.eblr_pct) * 10) / 10;
  if (raroc < pol.hurdle_pct) reasons.push(`RAROC ${raroc.toFixed(1)}% is below the ${pol.hurdle_pct}% hurdle.`);
  if (!reasons.length) reasons.push(`Within limit. RAROC ${raroc.toFixed(1)}% meets the ${pol.hurdle_pct}% hurdle.`);
  return { within_limit: reasons.length === 1 && reasons[0].startsWith("Within"), raroc, emi: Math.round(emi(amount, roi, tenure)), reasons };
}

on("POST", "/api/offers/{id}/quote", ({ u, m, body }) => {
  need(u, ["rm"]);
  const o = offerFor(u, m[1]);
  return quote(o, Number(body.amount), Number(body.roi), Number(body.tenure));
});

function pushEvent(o: Offer, actor: string, action: string, note: string | null, terms?: { amount: number; roi: number; tenure: number }) {
  const all = syntheticEvents(o);
  S.events.push({
    event_id: Date.now() + Math.floor(Math.random() * 1000),
    offer_id: o.offer_id,
    actor,
    action,
    amount: terms?.amount ?? null,
    roi: terms?.roi ?? null,
    tenure: terms?.tenure ?? null,
    note,
    at: new Date(Math.max(Date.now(), all.length ? new Date(all[all.length - 1].at).getTime() + 1000 : 0)).toISOString(),
  });
}

function patch(o: Offer, p: Partial<Offer>) {
  S.offerPatches[o.offer_id] = { ...(S.offerPatches[o.offer_id] ?? {}), ...p, updated_at: now() };
  return offerById(o.offer_id)!;
}

on("POST", "/api/offers/{id}/propose", ({ u, m, body }) => {
  need(u, ["rm"]);
  const o = offerFor(u, m[1]);
  if (!["OFFERED", "NEGOTIATING", "ESCALATED"].includes(o.stage)) throw new HttpError(409, `Offer is ${o.stage}, so its terms can no longer change.`);
  const t = { amount: Number(body.amount), roi: Number(body.roi), tenure: Number(body.tenure) };
  const qq = quote(o, t.amount, t.roi, t.tenure);
  pushEvent(o, u.username, "PROPOSE", (body.note as string) || null, t);
  if (!qq.within_limit) pushEvent(o, "system", "ESCALATE", qq.reasons.join(" "));
  audit(u, "PROPOSE", `offer ${o.offer_id}`, qq.within_limit ? "within limit" : "escalated");
  return patch(o, { stage: qq.within_limit ? "NEGOTIATING" : "ESCALATED", agreed_amount: t.amount, agreed_roi: t.roi, agreed_tenure: t.tenure });
});

for (const action of ["verify", "sanction", "reject"] as const) {
  on("POST", `/api/offers/{id}/${action}`, ({ u, m, body }) => {
    need(u, ["loanops"]);
    const o = offerFor(u, m[1]);
    const note = String(body.note ?? "").trim();
    if (!note) throw new HttpError(422, "A note is required.");
    if (action === "verify" && !["NEGOTIATING", "ESCALATED"].includes(o.stage)) throw new HttpError(409, `Only proposed or escalated offers can be verified. This one is ${o.stage}.`);
    if (action === "sanction" && o.stage !== "VERIFIED") throw new HttpError(409, "Only verified offers can be sanctioned.");
    if (action === "reject" && ["SANCTIONED", "DECLINED"].includes(o.stage)) throw new HttpError(409, `Offer is already ${o.stage}.`);
    pushEvent(o, u.username, action.toUpperCase(), note);
    audit(u, action.toUpperCase(), `offer ${o.offer_id}`, note);
    return patch(o, { stage: action === "verify" ? "VERIFIED" : action === "sanction" ? "SANCTIONED" : "DECLINED" });
  });
}

on("GET", "/api/offers/{id}/events", ({ u, m }) => {
  need(u, ["rm", "loanops", "admin"]);
  return syntheticEvents(offerFor(u, m[1]));
});

/* ------------------------------ generative AI ------------------------------ */

const AI_MODEL = "claude-sonnet-5-5";
const memos: Record<string, CreditMemo> = {};

on("GET", "/api/ai/status", () => ({ enabled: true, provider: "anthropic", model: AI_MODEL, assistant: true }));

const LATEST_RUN_SQL = `(SELECT "RUN_ID" FROM "CREDORA"."DECISIONS" GROUP BY "RUN_ID" ORDER BY MAX("DECIDED_AT") DESC LIMIT 1)`;

function askFixture(question: string): AskAnswer {
  if (!S.analysed) throw new HttpError(404, "No analysis has run on this data set yet.");
  const { scored: sc } = scored();
  const all = world.all();
  const q = question.toLowerCase();
  const run = lastRun()!.run_id;
  const step = (sql: string, columns: string[], rows: (string | number)[][]): AskStep => ({
    tool: "execute_exasol_query",
    input: { query: sql },
    result_preview: JSON.stringify({ columns, rows }),
  });
  if (q.includes("raroc")) {
    const top = all
      .filter((c) => sc[c.idx].decision === "APPROVE")
      .sort((a, b) => sc[b.idx].raroc - sc[a.idx].raroc)
      .slice(0, 5);
    const rows = top.map((c) => [c.legal_name, sc[c.idx].grade, Number(sc[c.idx].raroc.toFixed(1)), Math.round(sc[c.idx].amount)]);
    return {
      model: AI_MODEL,
      run_id: run,
      steps: [
        step(
          `SELECT "LEGAL_NAME", "GRADE", "RAROC_OFFER", "OFFER_AMOUNT"\nFROM "CREDORA"."DECISIONS"\nWHERE "RUN_ID" = ${LATEST_RUN_SQL}\n  AND "DECISION" = 'APPROVE'\nORDER BY "RAROC_OFFER" DESC\nLIMIT 5`,
          ["LEGAL_NAME", "GRADE", "RAROC_OFFER", "OFFER_AMOUNT"],
          rows,
        ),
      ],
      answer:
        `The five approved companies with the highest RAROC in run ${run}.\n\n` +
        top
          .map((c) => `- ${c.legal_name} (grade ${sc[c.idx].grade}): RAROC ${sc[c.idx].raroc.toFixed(1)}% on an offer of ${rupeesShort(sc[c.idx].amount)}`)
          .join("\n"),
    };
  }
  if (q.includes("gst") && q.includes("declin")) {
    const declined = all.filter((c) => sc[c.idx].decision === "DECLINE");
    const gst = declined.filter((c) => (sc[c.idx].hard_fail ?? "").startsWith("GST"));
    return {
      model: AI_MODEL,
      run_id: run,
      steps: [
        step(
          `SELECT COUNT(*) "DECLINED",\n       SUM(CASE WHEN "HARD_FAILS" LIKE '%GST%' THEN 1 ELSE 0 END) "GST_LATE"\nFROM "CREDORA"."DECISIONS"\nWHERE "RUN_ID" = ${LATEST_RUN_SQL}\n  AND "DECISION" = 'DECLINE'`,
          ["DECLINED", "GST_LATE"],
          [[declined.length, gst.length]],
        ),
      ],
      answer: `${gst.length} of the ${declined.length} declined companies in run ${run} were declined because GST returns were not filed on time for 10 or more of the last 12 months. The others were declined on CIBIL findings or a probability of default above the cut-off.`,
    };
  }
  if (q.includes("roi") || q.includes("grade")) {
    const by: Record<string, { n: number; roi: number }> = {};
    for (const c of all) {
      const s = sc[c.idx];
      if (s.decision === "DECLINE") continue;
      by[s.grade] ??= { n: 0, roi: 0 };
      by[s.grade].n += 1;
      by[s.grade].roi += s.roi;
    }
    const rows = Object.keys(by)
      .sort()
      .map((g) => [g, by[g].n, Number((by[g].roi / by[g].n).toFixed(2))]);
    return {
      model: AI_MODEL,
      run_id: run,
      steps: [
        step(
          `SELECT "GRADE", COUNT(*) "OFFERS", ROUND(AVG("OFFER_ROI"), 2) "AVG_ROI"\nFROM "CREDORA"."DECISIONS"\nWHERE "RUN_ID" = ${LATEST_RUN_SQL}\n  AND "OFFER_ROI" IS NOT NULL\nGROUP BY "GRADE"\nORDER BY "GRADE"`,
          ["GRADE", "OFFERS", "AVG_ROI"],
          rows,
        ),
      ],
      answer:
        `Average offer ROI by grade in run ${run}, over approved and referred companies. Declined ones get no offer.\n\n` +
        rows.map((r) => `- ${r[0]}: ${Number(r[2]).toFixed(2)}% across ${r[1]} offers`).join("\n") +
        "\n\nROI rises as the grade worsens, because the risk spread follows the probability of default.",
    };
  }
  const rows = ["New", "Mid-level", "Stable"].map((st) => {
    const cs = all.filter((c) => c.stage === st);
    const n = (d: string) => cs.filter((c) => sc[c.idx].decision === d).length;
    return [st, n("APPROVE"), n("REFER"), n("DECLINE")];
  });
  return {
    model: AI_MODEL,
    run_id: run,
    steps: [
      {
        tool: "describe_exasol_tables_and_views",
        input: { schema_name: "CREDORA", table_names: ["DECISIONS", "V_COMPANY_MASKED"] },
        result_preview:
          '[{"name":"DECISIONS","columns":["RUN_ID","APP_ID","CIF_ID","DECISION","GRADE","PD","…"]},{"name":"V_COMPANY_MASKED","columns":["RUN_ID","APP_ID","GST_STAGE","INDUSTRY","…"]}]',
      },
      step(
        `SELECT m."GST_STAGE",\n       SUM(CASE WHEN d."DECISION" = 'APPROVE' THEN 1 ELSE 0 END) "APPROVE",\n       SUM(CASE WHEN d."DECISION" = 'REFER' THEN 1 ELSE 0 END) "REFER",\n       SUM(CASE WHEN d."DECISION" = 'DECLINE' THEN 1 ELSE 0 END) "DECLINE"\nFROM "CREDORA"."DECISIONS" d\nJOIN "CREDORA"."V_COMPANY_MASKED" m ON m."RUN_ID" = d."RUN_ID" AND m."APP_ID" = d."APP_ID"\nWHERE d."RUN_ID" = ${LATEST_RUN_SQL}\nGROUP BY m."GST_STAGE"`,
        ["GST_STAGE", "APPROVE", "REFER", "DECLINE"],
        rows,
      ),
    ],
    answer:
      `Fixture mode answers only a few questions, from synthetic data. Here is the decision mix by GST stage in run ${run}.\n\n` +
      rows.map((r) => `- ${r[0]}: ${r[1]} approve, ${r[2]} refer, ${r[3]} decline`).join("\n"),
  };
}

on("POST", "/api/ai/ask", ({ u, body }) => {
  const q = String(body.question ?? "").trim();
  if (!q) throw new HttpError(422, "Ask a question.");
  audit(u, "ASK_CREDORA", "", q.slice(0, 200));
  return u.role === "rm" ? askRmFixture(q) : askFixture(q);
});

/** The relationship manager's Ask Credora reads only the row-filtered V_RM_* views (her assigned companies). */
function askRmFixture(question: string): AskAnswer {
  const run = officialRun()?.run_id;
  if (!S.analysed || !run) throw new HttpError(404, "No published analysis yet.");
  const { scored: sc } = scored();
  const mine = world.all().filter((c) => assignedToMe(c.cif_id));
  const q = question.toLowerCase();
  const step = (sql: string, columns: string[], rows: (string | number)[][]): AskStep => ({
    tool: "execute_exasol_query",
    input: { query: sql },
    result_preview: JSON.stringify({ columns, rows }),
  });
  if (q.includes("status")) {
    const by = new Map<string, string[]>();
    for (const c of mine) {
      const s = historyOf(c.cif_id)[0]?.status ?? "ASSIGNED";
      by.set(s, [...(by.get(s) ?? []), c.legal_name]);
    }
    const rows = [...by].map(([s, n]) => [s, n.length]);
    return {
      model: AI_MODEL,
      run_id: run,
      steps: [
        step(
          `SELECT s."STATUS", COUNT(*) "COMPANIES"\nFROM (SELECT "CIF_ID", "STATUS", ROW_NUMBER() OVER (PARTITION BY "CIF_ID" ORDER BY "LOGGED_AT" DESC, "EVENT_ID" DESC) "RN"\n      FROM "CREDORA"."V_RM_LOAN_STATUS") s\nWHERE s."RN" = 1\nGROUP BY s."STATUS"\nORDER BY 2 DESC`,
          ["STATUS", "COMPANIES"],
          rows,
        ),
      ],
      answer:
        `Your ${mine.length} assigned companies by loan status (Exasol returns only your companies through V_RM_LOAN_STATUS).\n\n` +
        [...by].map(([s, n]) => `- ${s.replace("_", " ").toLowerCase()}: ${n.length} (${n.slice(0, 3).join(", ")}${n.length > 3 ? ", …" : ""})`).join("\n"),
    };
  }
  const top = mine
    .filter((c) => sc[c.idx].decision !== "DECLINE")
    .map((c) => ({ c, h: Math.max(0, sc[c.idx].max_amount - sc[c.idx].amount) }))
    .sort((a, b) => b.h - a.h)
    .slice(0, 5);
  return {
    model: AI_MODEL,
    run_id: run,
    steps: [
      step(
        `SELECT "LEGAL_NAME", "OFFER_AMOUNT", "MAX_AMOUNT", "MAX_AMOUNT" - "OFFER_AMOUNT" "HEADROOM"\nFROM "CREDORA"."V_RM_DECISIONS"\nWHERE "RUN_ID" = '${run}' AND "OFFER_AMOUNT" IS NOT NULL\nORDER BY "HEADROOM" DESC\nLIMIT 5`,
        ["LEGAL_NAME", "OFFER_AMOUNT", "MAX_AMOUNT", "HEADROOM"],
        top.map(({ c, h }) => [c.legal_name, Math.round(sc[c.idx].amount), Math.round(sc[c.idx].max_amount), Math.round(h)]),
      ),
    ],
    answer:
      `Of your assigned companies, these have the most negotiation headroom (negotiation limit minus pre-approved offer) in run ${run}.\n\n` +
      top.map(({ c, h }) => `- ${c.legal_name}: ${rupeesShort(h)} above the offer of ${rupeesShort(sc[c.idx].amount)}`).join("\n"),
  };
}

function memoFor(r: Report): string {
  const reasons = r.reasons.slice(0, 4);
  const up = reasons.filter((x) => x.contribution > 0).map((x) => x.text.charAt(0).toLowerCase() + x.text.slice(1));
  const down = reasons.filter((x) => x.contribution < 0).map((x) => x.text.charAt(0).toLowerCase() + x.text.slice(1));
  const decision = { APPROVE: "Approve", REFER: "Refer to the credit committee", DECLINE: "Decline" }[r.decision];
  return [
    `Decision: ${decision}. Grade ${r.grade}, probability of default ${(r.pd * 100).toFixed(2)}%, rank ${r.rank_no} of ${r.rank_of}.`,
    `Why: ${down.length ? down.join(", ") : "few strong positives"}${up.length ? `, weighed against ${up.join(", ")}` : ""}.`,
    `Watch: ${up[0] ?? "GST filing discipline and bank inflows"}. ${r.stage} stage, ${r.gst_years} years of GST.`,
    r.offer && r.limit
      ? `Negotiate: pre-approved offer ${rupeesShort(r.offer.amount)} at ${r.offer.roi.toFixed(2)}% for ${r.offer.tenure} months, with room up to ${rupeesShort(r.limit.max_amount)}, ROI down to ${r.limit.floor_roi.toFixed(2)}%, tenure up to ${r.limit.max_tenure} months.`
      : "Negotiate: no pre-approved offer, because the company does not meet policy.",
  ].join("\n");
}

on("GET", "/api/companies/{cif}/memo", ({ u, m }) => {
  need(u, ["admin", "datasci", "loanops", "rm"]);
  const c = companyFor(u, m[1]);
  const hit = memos[`${lastRun()?.run_id}:${c.cif_id}`];
  if (!hit) throw new HttpError(404, `No credit memo for ${c.cif_id} in this run yet.`);
  return hit;
});

on("POST", "/api/companies/{cif}/memo", ({ u, m }) => {
  need(u, ["admin", "datasci", "loanops", "rm"]);
  const c = companyFor(u, m[1]);
  const r = report(c);
  const out: CreditMemo = { memo: memoFor(r), model: AI_MODEL, engine: "exasol-udf", created_at: now(), run_id: r.run_id };
  memos[`${r.run_id}:${c.cif_id}`] = out;
  audit(u, "CREDIT_MEMO", c.cif_id, `exasol-udf, ${AI_MODEL}, run ${r.run_id}`);
  return out;
});

/* ------------------------------ fetch shim ------------------------------ */

function json(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Credora-Fixture": "1" },
  });
}

function userFromToken(h: Headers): User | null {
  const a = h.get("Authorization") ?? "";
  const m = /^Bearer fx\.(\w+)$/.exec(a);
  return m ? USERS[m[1]] ?? null : null;
}

export function installFixtures() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const quick = url.pathname.endsWith("/quote") || url.pathname.startsWith("/api/jobs/");
    await new Promise((r) => setTimeout(r, quick ? 60 + Math.random() * 60 : 160 + Math.random() * 260));

    if (url.pathname === "/api/auth/login" && method === "POST") {
      const u = USERS[String(body.username ?? "").toLowerCase()];
      if (!u || !String(body.password ?? "")) return json(401, { detail: "Wrong username or password." });
      S.audit.unshift({ at: now(), username: u.username, role: u.role, action: "LOGIN", target: u.username, detail: null });
      save();
      return json(200, { token: `fx.${u.username}`, user: u });
    }
    const u = userFromToken(headers);
    if (!u) return json(401, { detail: "Sign in to continue." });
    // Explain mode: the simulated Exasol console and the control room (fixtures/exasol.ts).
    const tab = headers.get("X-Credora-Session");
    const exa = exasolFixture(u, url.pathname, url.searchParams, tab);
    if (exa) return json(exa.status, exa.body);
    recordFixture(u, method, url.pathname, tab);
    for (const [m, re, h] of routes) {
      if (m !== method) continue;
      const match = re.exec(url.pathname);
      if (!match) continue;
      try {
        const out = h({ u, body, q: url.searchParams, m: match });
        if (method !== "GET") save();
        return json(200, out);
      } catch (e) {
        if (e instanceof HttpError) return json(e.status, { detail: e.message });
        console.error(e);
        return json(500, { detail: String(e) });
      }
    }
    return json(404, { detail: `No fixture for ${method} ${url.pathname}` });
  };
  // eslint-disable-next-line no-console
  console.info("[credora] fixture mode: /api is answered in the browser with synthetic data", { AS_OF });
}

export function resetFixtures() {
  S = fresh();
  world = new World(S.seed);
  scoredCache = null;
  save();
}
