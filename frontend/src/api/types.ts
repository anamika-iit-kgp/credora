// Types for the Credora backend API (docs/API.md).
// Shapes the contract leaves open are pinned down here; see frontend/README.md "API assumptions".

export type Role = "admin" | "datasci" | "loanops" | "rm";

export type SourceId =
  | "bank.oracle"
  | "bank.mysql"
  | "bank.postgres"
  | "api.cibil"
  | "api.gstn"
  | "api.aa"
  | "exasol";

export type SourceKind = "bank" | "api" | "exasol";

export type Decision = "APPROVE" | "REFER" | "DECLINE";
export type GstStage = "New" | "Mid-level" | "Stable";
export type OfferStage =
  | "OFFERED"
  | "NEGOTIATING"
  | "ESCALATED"
  | "VERIFIED"
  | "SANCTIONED"
  | "DECLINED";

export interface User {
  username: string;
  role: Role;
  display_name: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface SourceTable {
  name: string;
  rows: number;
}

export interface SourceHealth {
  source: SourceId;
  label: string;
  kind: SourceKind;
  status: "up" | "down";
  tables: SourceTable[];
  latency_ms: number | null;
}

export interface DecisionMix {
  APPROVE: number;
  REFER: number;
  DECLINE: number;
}

export interface Overview {
  counts: {
    companies: number;
    partners: number;
    applications: number;
    accounts: number;
  };
  last_generation: { seed: number; generated_at: string; job_id?: string } | null;
  last_analysis: {
    run_id: string;
    finished_at: string;
    duration_ms: number;
    model_version: string;
    published_by?: string | null;
    published_at?: string | null;
  } | null;
  decision_mix: DecisionMix | null;
  sources: SourceHealth[];
}

export type JobStatus = "running" | "done" | "failed";
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface JobStep {
  name: string;
  status: StepStatus;
  detail: string | null;
}

export interface Job {
  job_id: string;
  kind: "generate" | "analysis" | "train" | string;
  status: JobStatus;
  progress: number;
  steps: JobStep[];
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface JobRef {
  job_id: string;
}

/** POST /api/admin/generate. replace: clear everything and create 1,000 companies; append: keep the data and add `companies`. */
export interface GenerateRequest {
  seed: number | null;
  mode: "replace" | "append";
  companies: number;
}

export interface AuditEntry {
  at: string;
  username: string;
  role: Role;
  action: string;
  target: string;
  detail: string | null;
}

export interface PurgeEntry {
  purged_at: string;
  table_name: string;
  source: SourceId;
  rows: number;
  sha256: string;
  purge_due: string;
}

export interface CompanyRow {
  cif_id: string;
  legal_name: string;
  industry: string;
  city: string;
  stage: GstStage;
  partners: number;
  rm_id: string;
  decision: Decision | null;
  rank_no: number | null;
  offer_amount: number | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface TreeNode {
  id: string;
  label: string;
  sublabel: string | null;
  source: SourceId | null;
  kind: string;
  children: TreeNode[];
}

export type Cell = string | number | boolean | null;

export interface NodeRecords {
  node_id: string;
  title: string;
  source: SourceId;
  columns: string[];
  rows: Cell[][];
  meta: Record<string, Cell>;
}

export interface StageTiming {
  name: string;
  ms: number;
}

export interface Run {
  run_id: string;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  started_by: string;
  model_version: string;
  companies: number;
  approve: number;
  refer: number;
  decline: number;
  stages: StageTiming[];
  /** A finished run is a draft until the data scientist publishes it to loan operations. */
  published?: boolean;
  published_by?: string | null;
  published_at?: string | null;
  publish_note?: string | null;
}

export interface DecisionRow {
  cif_id: string;
  legal_name: string;
  decision: Decision;
  grade: string;
  pd: number;
  rank_no: number;
  offer_amount: number | null;
  offer_roi: number | null;
  offer_tenure: number | null;
  raroc: number | null;
  /** Relationship manager loan operations assigned the company to (CREDORA.RM_ASSIGNMENT). */
  assigned_rm_id?: string | null;
}

export interface Top50Row {
  rank_no: number;
  cif_id: string;
  legal_name: string;
  industry: string;
  grade: string;
  pd: number;
  raroc: number;
  offer_amount: number;
  stage: OfferStage | null;
  assigned_rm_id?: string | null;
}

export interface Terms {
  amount: number;
  roi: number;
  tenure: number;
}

export interface Limit {
  max_amount: number;
  floor_roi: number;
  max_tenure: number;
}

export interface Reason {
  feature: string;
  text: string;
  contribution: number; // change in probability of default, percentage points; negative lowers risk
  source: SourceId;
}

export interface Feature {
  name: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  source: SourceId;
}

export interface ReportStep {
  n: number;
  name: string;
  what: string;
  engine: string; // "SQL" | "Lua" | "Python UDF" | "PREFERRING" ...
  object: string;
  language: "sql" | "lua" | "python";
  code: string;
  sources: SourceId[];
  ms: number | null;
}

/** The pricing inputs the decision used, stored with it in CREDORA.DECISIONS (docs/PRICING.md). */
export interface Pricing {
  industry: string | null;
  /** cash margin on GST turnover, % (CREDORA.INDUSTRY_MARGIN) */
  cash_margin_pct: number | null;
  /** cash available for debt service a year, INR */
  cash_12m: number | null;
  collateral_type: string | null;
  collateral_value: number | null;
  /** loss given default after the collateral, % (CREDORA.LGD_COLLATERAL blended by coverage) */
  lgd_pct: number | null;
  /** the company's exposure at all lenders on its CIBIL commercial report, INR */
  existing_exposure: number | null;
  /** room left under the total exposure cap, INR */
  exposure_room: number | null;
}

export interface Report {
  cif_id: string;
  legal_name: string;
  run_id: string;
  model_version: string;
  generated_at: string;
  stage: GstStage;
  gst_years: number;
  partners: number;
  decision: Decision;
  grade: string;
  pd: number;
  rank_no: number;
  rank_of: number;
  raroc: number | null;
  offer: Terms | null;
  limit: Limit | null;
  requested: Terms & { product: string };
  offer_id: number | null;
  reasons: Reason[];
  features: Feature[];
  steps: ReportStep[];
  sources_used: SourceId[];
  /** Policy rules that failed and other referral reasons, e.g. "Anomaly: GST turnover far above bank credits". */
  hard_fails?: string[];
  /** Isolation Forest result from CREDORA.ANOMALY; null for relationship managers (no grant) and older runs. */
  anomaly?: AnomalyResult | null;
  /** How the offer was priced; null for runs made before the inputs were stored. */
  pricing?: Pricing | null;
}

export interface AnomalyResult {
  score: number;
  flagged: boolean;
  reasons: string[];
}

export interface FeatureImportance {
  feature: string;
  importance: number;
}

export interface Model {
  version: string;
  algorithm: string;
  trained_at: string;
  trained_by: string;
  train_rows: number;
  auc: number;
  gini: number;
  active: boolean;
  /** champion = active model; challenger = newest inactive model of the other algorithm. */
  role?: "champion" | "challenger" | null;
  /** importance = permutation importance (trees); coefficient = signed scorecard coefficient. */
  kind?: "importance" | "coefficient";
  feature_importance: FeatureImportance[];
}

export interface ModelCard {
  version: string;
  algorithm: string;
  active: boolean;
  auc: number | null;
  gini: number | null;
  kind: "importance" | "coefficient";
  top: FeatureImportance[];
}

export interface ModelComparison {
  run_id: string | null;
  active_version: string | null;
  champion: ModelCard | null;
  challenger: ModelCard | null;
  same_holdout: boolean;
  /** false until CREDORA.SCORE_CHALLENGER has scored the current run */
  scored: boolean;
  companies: number;
  grades_changed: number;
  decisions_changed: number;
  champion_mean_pd: number | null;
  challenger_mean_pd: number | null;
  transitions: { from: Decision; to: Decision; n: number }[];
  changed: {
    cif_id: string;
    legal_name: string;
    from: Decision;
    to: Decision;
    champion_pd: number;
    challenger_pd: number;
    champion_grade: string;
    challenger_grade: string;
  }[];
}

export interface WhatIfParams {
  hurdle_pct?: number;
  eblr_pct?: number;
  max_gst_share_pct?: number;
}

export interface WhatIfResult {
  params: Required<WhatIfParams>;
  baseline: Required<WhatIfParams>;
  before: DecisionMix;
  after: DecisionMix;
  /** Total pre-approved offer amount (APPROVE decisions), official run and with these levers. */
  before_amount?: number;
  after_amount?: number;
  run_id?: string;
  model_version?: string;
  ms?: number;
}

/* ---------- policy maker-checker: datasci proposes, admin approves ---------- */

export type ProposalStatus = "PENDING" | "APPROVED" | "REJECTED";

/** A saved what-if run (crm.whatif_run). */
export interface WhatIfRun {
  run_id: string; // W0001
  created_at: string;
  created_by: string;
  base_run_id: string; // the official analysis run it re-decided
  model_version: string;
  levers: Required<WhatIfParams>;
  baseline: Required<WhatIfParams>;
  before: DecisionMix;
  after: DecisionMix;
  before_amount: number | null;
  after_amount: number | null;
  ms: number | null;
  proposal: { proposal_id: number; status: ProposalStatus } | null;
}

export interface PolicyLeverChange {
  key: string; // CREDORA.CONFIG key, e.g. HURDLE_PCT
  lever: keyof WhatIfParams;
  label: string;
  old: number;
  new: number;
}

export type OutcomeMix = DecisionMix & { amount: number | null };

export interface PolicyProposal {
  proposal_id: number;
  created_at: string;
  created_by: string;
  run_id: string;
  levers: PolicyLeverChange[];
  outcome: { base_run_id: string; current: OutcomeMix; proposed: OutcomeMix };
  note: string;
  status: ProposalStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  applied_run_id: string | null;
  /** PENDING only: CREDORA.CONFIG no longer holds the proposal's starting values, so it cannot be approved. */
  baseline_changed?: boolean;
}

export interface ApproveResult {
  job_id: string;
  run_id: string;
  proposal: PolicyProposal;
}

export interface Offer {
  offer_id: number;
  run_id: string;
  app_id: string;
  cif_id: string;
  legal_name: string;
  rm_id: string;
  decision: Decision;
  grade: string | null;
  pd: number | null;
  rank_no: number | null;
  offer_amount: number | null;
  offer_roi: number | null;
  offer_tenure: number | null;
  floor_roi: number | null;
  max_amount: number | null;
  max_tenure: number | null;
  stage: OfferStage;
  agreed_amount: number | null;
  agreed_roi: number | null;
  agreed_tenure: number | null;
  updated_at: string;
}

export interface Quote {
  within_limit: boolean;
  raroc: number;
  emi: number;
  /** loss given default the RAROC used, %: the decision's figure after collateral, else the policy LGD */
  lgd_pct?: number | null;
  reasons: string[];
}

export interface OfferEvent {
  event_id: number;
  offer_id: number;
  actor: string;
  action: "PROPOSE" | "SUBMIT" | "ESCALATE" | "VERIFY" | "SANCTION" | "REJECT" | "NOTE" | string;
  amount: number | null;
  roi: number | null;
  tenure: number | null;
  note: string | null;
  at: string;
}

export interface ApiErrorBody {
  detail?: string;
}

/* ---------- generative AI ---------- */

export interface AiStatus {
  enabled: boolean;
  provider: "anthropic" | "bedrock" | null;
  model: string | null;
  assistant?: boolean; // Ask Credora: AI plus the Exasol MCP user's password
}

export interface AskStep {
  tool: string; // Exasol MCP server tool, e.g. execute_exasol_query
  input: Record<string, unknown>;
  result_preview: string;
  is_error?: boolean;
}

export interface AskAnswer {
  answer: string;
  steps: AskStep[];
  model: string;
  run_id?: string | null;
  /** The Exasol user the MCP server logged in as (the caller's role user). */
  exasol_user?: string | null;
}

export type MemoEngine = "exasol-udf" | "backend";

export interface CreditMemo {
  memo: string;
  model: string;
  engine: MemoEngine;
  created_at: string | null;
  run_id?: string;
}

/* ---------- hand-offs between the roles ---------- */

/** Risk-model activation request (crm.model_activation_request): datasci requests, admin decides. */
export interface ModelMetricsCard {
  version: string;
  algorithm: string;
  auc: number | null;
  gini: number | null;
}

export interface ActivationRequest {
  request_id: number;
  created_at: string;
  created_by: string;
  model_version: string;
  current_version: string | null;
  metrics: { candidate: ModelMetricsCard | null; current: ModelMetricsCard | null };
  note: string;
  status: ProposalStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  /** PENDING only: another model became active since the request, so it cannot be approved. */
  baseline_changed?: boolean;
}

export interface PendingApprovals {
  policy: number;
  models: number;
}

export interface RmInfo {
  rm_id: string;
  name: string;
  branch: string;
  assigned: number;
}

export interface Assignment {
  cif_id: string;
  rm_id: string;
  assigned_by: string;
  assigned_at: string;
}

export interface AssignResult {
  rm_id: string;
  assigned: number;
  moved: number;
  unchanged: number;
}

export type LoanStatus = "ASSIGNED" | "CONTACTED" | "NEGOTIATING" | "LOAN_TAKEN" | "IN_PROGRESS" | "DISBURSED" | "NOT_INTERESTED";

export interface LoanStatusEvent {
  event_id: number;
  cif_id: string;
  rm_id: string;
  status: LoanStatus;
  note: string | null;
  actor: string;
  at: string;
}

/** One assigned company in the Loan status tracker (CREDORA.RM_ASSIGNMENT + CREDORA.LOAN_STATUS_LOG). */
export interface LoanStatusRow {
  cif_id: string;
  legal_name: string;
  rm_id: string;
  rm_name: string;
  assigned_by: string;
  assigned_at: string;
  decision: Decision | null;
  rank_no: number | null;
  offer_amount: number | null;
  status: LoanStatus;
  note: string | null;
  updated_at: string;
  updated_by: string;
  history: LoanStatusEvent[];
  /** The company's newest CRM offer and its stage. */
  offer_id?: number | null;
  offer_stage?: string | null;
  /** Why Loan taken is not open yet (no agreed or sanctioned terms), or null. */
  offer_block?: string | null;
  /** The statuses the relationship manager can log next (the state machine in app/rmbook.py). */
  next_statuses?: LoanStatus[];
}
