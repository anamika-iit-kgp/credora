// Synthetic world for fixture mode. Deterministic from a seed, built lazily per company.
// Mirrors docs/DATA_MODEL.md: 1,000 companies (more after "Add more companies"), 2–5 partners each, CIBIL, 2–10 years of GST, AA accounts.

import type { Decision, GstStage } from "../api/types";

export function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = () => number;
export const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export const between = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
export const int = (r: Rng, lo: number, hi: number) => Math.floor(between(r, lo, hi + 1));
export const round = (x: number, step: number) => Math.round(x / step) * step;
const pad = (n: number, w: number) => String(n).padStart(w, "0");

export const AS_OF = new Date("2026-10-31T12:00:00Z"); // noon UTC keeps ISO dates on the same calendar day in IST
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addMonths = (d: Date, m: number) => {
  const x = new Date(d);
  x.setMonth(x.getMonth() + m);
  return x;
};
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

const PREFIX = [
  "Shree Ganesh", "Om Sai", "Kaveri", "Narmada", "Deccan", "Sahyadri", "Vardhman", "Lakshmi", "Arihant", "Konkan",
  "Malabar", "Gomti", "Tapti", "Shakti", "Aravali", "Godavari", "Nilgiri", "Sabari", "Coromandel", "Vindhya",
  "Satpura", "Ganga", "Yamuna", "Kaveri Valley", "Bhagirath", "Jayant", "Prakash", "Suryodaya", "Navkar", "Mahalaxmi",
  "Annapurna", "Ashoka", "Indraprastha", "Kalinga", "Chola", "Hoysala", "Vijayanagar", "Rajhans", "Neelkanth", "Pragati",
] as const;

const INDUSTRIES: { name: string; nouns: string[] }[] = [
  { name: "Plastics and polymers", nouns: ["Polymers", "Plastics", "Poly Packs"] },
  { name: "Textiles", nouns: ["Textiles", "Spinning Mills", "Fabrics"] },
  { name: "Food processing", nouns: ["Agro Foods", "Food Products", "Spices"] },
  { name: "Steel and metals", nouns: ["Steel Fabricators", "Metal Works", "Alloys"] },
  { name: "Pharmaceuticals", nouns: ["Pharma", "Life Sciences", "Formulations"] },
  { name: "Auto components", nouns: ["Auto Components", "Forgings", "Auto Parts"] },
  { name: "Logistics", nouns: ["Logistics", "Roadways", "Freight Carriers"] },
  { name: "Packaging", nouns: ["Packaging", "Containers", "Cartons"] },
  { name: "Electricals", nouns: ["Electricals", "Cables", "Switchgear"] },
  { name: "Chemicals", nouns: ["Chemicals", "Dyes and Intermediates", "Industrial Gases"] },
  { name: "Building materials", nouns: ["Ceramics", "Cement Products", "Tiles"] },
  { name: "Paper and printing", nouns: ["Paper Mills", "Printers"] },
  { name: "Engineering", nouns: ["Engineering Works", "Machine Tools", "Pumps"] },
  { name: "Agri trading", nouns: ["Agro Traders", "Commodities", "Rice Mills"] },
];

const CITIES: { city: string; state: string; code: string }[] = [
  { city: "Mumbai", state: "Maharashtra", code: "27" },
  { city: "Pune", state: "Maharashtra", code: "27" },
  { city: "Nashik", state: "Maharashtra", code: "27" },
  { city: "Nagpur", state: "Maharashtra", code: "27" },
  { city: "Ahmedabad", state: "Gujarat", code: "24" },
  { city: "Surat", state: "Gujarat", code: "24" },
  { city: "Rajkot", state: "Gujarat", code: "24" },
  { city: "Vadodara", state: "Gujarat", code: "24" },
  { city: "Bengaluru", state: "Karnataka", code: "29" },
  { city: "Mysuru", state: "Karnataka", code: "29" },
  { city: "Chennai", state: "Tamil Nadu", code: "33" },
  { city: "Coimbatore", state: "Tamil Nadu", code: "33" },
  { city: "Tiruppur", state: "Tamil Nadu", code: "33" },
  { city: "Hyderabad", state: "Telangana", code: "36" },
  { city: "New Delhi", state: "Delhi", code: "07" },
  { city: "Noida", state: "Uttar Pradesh", code: "09" },
  { city: "Kanpur", state: "Uttar Pradesh", code: "09" },
  { city: "Ludhiana", state: "Punjab", code: "03" },
  { city: "Jaipur", state: "Rajasthan", code: "08" },
  { city: "Indore", state: "Madhya Pradesh", code: "23" },
  { city: "Kolkata", state: "West Bengal", code: "19" },
  { city: "Kochi", state: "Kerala", code: "32" },
  { city: "Visakhapatnam", state: "Andhra Pradesh", code: "37" },
];

const FIRST_M = ["Rohit", "Suresh", "Anil", "Vikram", "Rajesh", "Arvind", "Karthik", "Mahesh", "Imran", "Farhan", "Sanjay", "Deepak", "Ramesh", "Venkat", "Srinivas", "Harpreet", "Aditya", "Nikhil", "Gaurav", "Prakash"];
const FIRST_F = ["Priya", "Anjali", "Kavita", "Meera", "Sunita", "Lakshmi", "Nandini", "Ayesha", "Gurpreet", "Shalini", "Pooja", "Revathi", "Farida", "Ritu"];
const LAST = ["Mehta", "Iyer", "Khan", "Shah", "Patel", "Reddy", "Nair", "Agarwal", "Gupta", "Singh", "Rao", "Menon", "Joshi", "Kulkarni", "Chatterjee", "Banerjee", "Desai", "Pillai", "Sethi", "Malhotra", "Jain", "Verma", "Bhat", "Hegde", "Siddiqui"];
export const FIPS = ["State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Mahindra Bank", "Punjab National Bank", "Bank of Baroda", "Canara Bank", "Union Bank of India", "IndusInd Bank"];
const LENDERS = ["HDFC Bank", "ICICI Bank", "State Bank of India", "Axis Bank", "Bajaj Finance", "Kotak Mahindra Bank", "Tata Capital"];
const CONSUMER_TYPES = ["Home Loan", "Personal Loan", "Credit Card", "Auto Loan", "Business Loan", "Gold Loan"];
const BRANCHES = ["Fort, Mumbai", "Baner, Pune", "CG Road, Ahmedabad", "Koramangala, Bengaluru", "T Nagar, Chennai", "Banjara Hills, Hyderabad", "Connaught Place, New Delhi", "Park Street, Kolkata", "MI Road, Jaipur", "Ring Road, Surat"];

export const RMS = Array.from({ length: 12 }, (_, i) => ({
  rm_id: `RM${pad(i + 1, 3)}`,
  name: [`Subhashree Mohanty`, `Neha Kapoor`, `Arun Pillai`, `Sneha Kulkarni`, `Rahul Bansal`, `Divya Menon`, `Vikram Desai`, `Manish Arora`, `Fatima Sheikh`, `Kiran Rao`, `Tarun Saxena`, `Asha Thomas`][i],
  branch: BRANCHES[i % BRANCHES.length],
}));

/** The demo RM user acts for RM001 (Exasol user CREDORA_RM); her book is what loan operations assigns. */
export const DEMO_RM = "RM001";

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function pan(r: Rng, typeLetter: string, nameLetter: string) {
  const l = () => LETTERS[Math.floor(r() * 26)];
  return `${l()}${l()}${l()}${typeLetter}${nameLetter.toUpperCase()}${pad(int(r, 0, 9999), 4)}${l()}`;
}
function gstin(stateCode: string, p: string) {
  const base = `${stateCode}${p}1Z`;
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    const v = ALNUM.indexOf(base[i]);
    const prod = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return base + ALNUM[(36 - (sum % 36)) % 36];
}

export interface Partner {
  partner_id: string;
  cif_id: string;
  name: string;
  pan: string;
  dob: string;
  gender: "M" | "F";
  role: "Director" | "Partner" | "Promoter";
  share_pct: number;
  city: string;
  sapphire_customer: boolean;
  score: number;
  enquiries_6m: number;
  enquiries_12m: number;
  overdue: number;
  bureau_accounts: number;
  sapphire_acct: string | null;
  aa_accounts: { aa_account_id: string; fip: string; acct_type: "SAVINGS" | "CURRENT"; masked_no: string; opened_on: string; current_balance: number }[];
}

export interface Company {
  idx: number;
  cif_id: string;
  legal_name: string;
  constitution: string;
  pan: string;
  gstin: string;
  incorporated_on: string;
  industry: string;
  city: string;
  state: string;
  rm_id: string;
  kyc_status: string;
  kyc_expiry: string;
  customer_since: string;
  risk: number; // hidden truth
  gst_years: number;
  stage: GstStage;
  gst_registered_on: string;
  turnover_12m: number;
  late_filings_12m: number;
  gap_pct: number;
  avg_balance: number;
  volatility: number;
  bounce_ratio: number;
  cmr_rank: number;
  cmr_exposure: number;
  cmr_overdue: number;
  wilful_default: boolean;
  suit_filed: boolean;
  facilities: number;
  account_no: string;
  account_branch: string;
  account_opened: string;
  txn_months: number;
  app_id: string;
  applied_on: string;
  product: "WC" | "TL";
  amount_requested: number;
  tenure_requested: number;
  purpose: string;
  collateral_type: string;
  collateral_value: number;
  partner_count: number;
}

export class World {
  seed: number;
  private cache = new Map<number, Company>();
  private pcache = new Map<string, Partner[]>();
  readonly size: number;
  constructor(seed: number, size = 1000) {
    this.seed = seed;
    this.size = size;
  }

  company(i: number): Company {
    const hit = this.cache.get(i);
    if (hit) return hit;
    const r = mulberry32(this.seed * 7919 + i * 104729);
    const ind = pick(r, INDUSTRIES);
    const prefix = pick(r, PREFIX);
    const noun = pick(r, ind.nouns);
    const consRoll = r();
    const constitution =
      consRoll < 0.55 ? "Private Limited" : consRoll < 0.75 ? "LLP" : consRoll < 0.93 ? "Partnership" : "Public Limited";
    const suffix =
      constitution === "Private Limited" ? "Pvt Ltd" : constitution === "LLP" ? "LLP" : constitution === "Partnership" ? "and Co" : "Ltd";
    const legal_name = `${prefix} ${noun} ${suffix}`;
    const loc = pick(r, CITIES);
    const cp = pan(r, constitution === "LLP" || constitution === "Partnership" ? "F" : "C", prefix[0]);
    // hidden risk: skewed towards good companies
    const risk = Math.pow(r(), 1.9);
    const gst_years = int(r, 2, 10);
    const stage: GstStage = gst_years <= 4 ? "New" : gst_years <= 7 ? "Mid-level" : "Stable";
    const turnover_12m = round(between(r, 4.5e7, 6.2e8) * (stage === "New" ? 0.55 : stage === "Stable" ? 1.35 : 1), 10000);
    const amount_requested = round(turnover_12m * between(r, 0.08, 0.26), 500000);
    const product: "WC" | "TL" = r() < 0.62 ? "WC" : "TL";
    const txn_months = int(r, 12, 24);
    const incorporatedYears = gst_years + int(r, 0, 9);
    const incorporated = addMonths(AS_OF, -12 * incorporatedYears - int(r, 0, 11));
    const customerSince = addMonths(AS_OF, -txn_months - int(r, 0, 60));
    const regOn = addMonths(AS_OF, -Math.round(gst_years * 12) - 1);
    const collateral_type = pick(r, ["Property", "Plant & machinery", "Receivables", "None"] as const);
    const kycRoll = r();
    const c: Company = {
      idx: i,
      cif_id: `C${pad(i + 1, 6)}`,
      legal_name,
      constitution,
      pan: cp,
      gstin: gstin(loc.code, cp),
      incorporated_on: iso(incorporated),
      industry: ind.name,
      city: loc.city,
      state: loc.state,
      rm_id: RMS[Math.floor(r() * RMS.length)].rm_id,
      kyc_status: kycRoll < 0.9 ? "VERIFIED" : kycRoll < 0.96 ? "PENDING" : "EXPIRED",
      kyc_expiry: iso(addMonths(AS_OF, int(r, -3, 30))),
      customer_since: iso(customerSince),
      risk,
      gst_years,
      stage,
      gst_registered_on: iso(regOn),
      turnover_12m,
      late_filings_12m: Math.min(12, Math.round(risk * 9 * r() + (risk > 0.7 ? 2 : 0))),
      gap_pct: Math.round((2 + risk * 38 * between(r, 0.4, 1.2)) * 10) / 10,
      avg_balance: round(turnover_12m * between(r, 0.02, 0.09) * (1.2 - risk) * between(r, 0.6, 1.4) * 0.6, 1000),
      volatility: Math.round((0.12 + risk * 0.6 * between(r, 0.5, 1.3)) * 1000) / 1000,
      bounce_ratio: Math.round(Math.max(0, risk * 0.09 * between(r, 0.2, 1.5) - 0.004) * 10000) / 10000,
      cmr_rank: Math.max(1, Math.min(10, Math.round(1 + risk * 8 + between(r, -1.2, 1.2)))),
      cmr_exposure: round(turnover_12m * between(r, 0.05, 0.35), 100000),
      cmr_overdue: risk > 0.75 && r() < 0.5 ? round(between(r, 2e5, 4e6), 1000) : 0,
      wilful_default: risk > 0.93 && r() < 0.4,
      suit_filed: risk > 0.88 && r() < 0.3,
      facilities: int(r, 1, 7),
      account_no: `5011${pad(i + 1, 10)}`,
      account_branch: pick(r, BRANCHES),
      account_opened: iso(customerSince),
      txn_months,
      app_id: `A${pad(i + 1, 7)}`,
      applied_on: iso(addDays(AS_OF, -int(r, 3, 40))),
      product,
      amount_requested,
      tenure_requested: product === "WC" ? pick(r, [12, 24, 36]) : pick(r, [36, 48, 60, 72, 84]),
      purpose:
        product === "WC"
          ? pick(r, ["Working capital for raw material", "Inventory build-up for festive season", "Receivables financing"])
          : pick(r, ["New production line", "Warehouse expansion", "Fleet purchase", "Plant modernisation"]),
      collateral_type,
      collateral_value: collateral_type === "None" ? 0 : round(amount_requested * between(r, 0.6, 1.8), 100000),
      partner_count: int(r, 2, 5),
    };
    this.cache.set(i, c);
    return c;
  }

  byCif(cif: string): Company | null {
    const m = /^C(\d{6})$/.exec(cif);
    if (!m) return null;
    const i = Number(m[1]) - 1;
    return i >= 0 && i < this.size ? this.company(i) : null;
  }

  all(): Company[] {
    return Array.from({ length: this.size }, (_, i) => this.company(i));
  }

  partners(c: Company): Partner[] {
    const hit = this.pcache.get(c.cif_id);
    if (hit) return hit;
    const r = mulberry32(this.seed * 31 + c.idx * 7 + 3);
    // shares add to 100
    const weights = Array.from({ length: c.partner_count }, () => between(r, 0.5, 2));
    const total = weights.reduce((a, b) => a + b, 0);
    let shares = weights.map((w) => Math.round((w / total) * 10000) / 100);
    shares[0] = Math.round((100 - shares.slice(1).reduce((a, b) => a + b, 0)) * 100) / 100;
    const role: Partner["role"] = c.constitution === "Partnership" || c.constitution === "LLP" ? "Partner" : "Director";
    const ps: Partner[] = shares.map((share_pct, k) => {
      const female = r() < 0.3;
      const first = pick(r, female ? FIRST_F : FIRST_M);
      const last = pick(r, LAST);
      const pr = Math.min(1, Math.max(0, c.risk + between(r, -0.25, 0.25)));
      const score = Math.round(Math.min(890, Math.max(420, 860 - pr * 330 + between(r, -40, 40))));
      const sapphire = r() < 0.3;
      const nAA = int(r, 1, 3);
      const pid = `P${pad(c.idx * 5 + k + 1, 7)}`;
      return {
        partner_id: pid,
        cif_id: c.cif_id,
        name: `${first} ${last}`,
        pan: pan(r, "P", last[0]),
        dob: iso(addMonths(AS_OF, -12 * int(r, 29, 66) - int(r, 0, 11))),
        gender: female ? "F" : "M",
        role: k === 0 && role === "Director" ? "Promoter" : role,
        share_pct,
        city: c.city,
        sapphire_customer: sapphire,
        score,
        enquiries_6m: Math.round(pr * 4 * r()),
        enquiries_12m: Math.round(pr * 6 * r()) + 1,
        overdue: pr > 0.7 && r() < 0.5 ? round(between(r, 15000, 600000), 500) : 0,
        bureau_accounts: int(r, 1, 6),
        sapphire_acct: sapphire ? `5011${pad(500000 + c.idx * 5 + k, 10)}` : null,
        aa_accounts: Array.from({ length: nAA }, (_, j) => ({
          aa_account_id: `AA${pad(c.idx * 15 + k * 3 + j + 1, 8)}`,
          fip: pick(r, FIPS),
          acct_type: (r() < 0.75 ? "SAVINGS" : "CURRENT") as "SAVINGS" | "CURRENT",
          masked_no: `XXXXXX${pad(int(r, 1000, 9999), 4)}`,
          opened_on: iso(addMonths(AS_OF, -int(r, 18, 180))),
          current_balance: round(between(r, 40000, 4.5e6) * (1.1 - pr), 100),
        })),
      };
    });
    this.pcache.set(c.cif_id, ps);
    return ps;
  }

  rng(key: string): Rng {
    let h = this.seed;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 2654435761);
    return mulberry32(h);
  }

  bureauAccounts(p: Partner) {
    const r = this.rng(`cibil:${p.pan}`);
    return Array.from({ length: p.bureau_accounts }, (_, i) => {
      const type = pick(r, CONSUMER_TYPES);
      const sanctioned = round(
        type === "Home Loan" ? between(r, 2e6, 1.2e7) : type === "Credit Card" ? between(r, 1e5, 8e5) : between(r, 2e5, 3e6),
        1000,
      );
      const closed = r() < 0.25;
      const dpd = Array.from({ length: 36 }, () => (p.score < 650 && r() < 0.18 ? pick(r, [30, 60, 90]) : p.score < 720 && r() < 0.04 ? 30 : 0));
      return {
        lender: pick(r, LENDERS),
        acct_type: type,
        opened_on: iso(addMonths(AS_OF, -int(r, 8, 140))),
        sanctioned,
        balance: closed ? 0 : round(sanctioned * between(r, 0.1, 0.85), 100),
        overdue: i === 0 ? p.overdue : 0,
        status: closed ? "CLOSED" : "ACTIVE",
        dpd_36m: dpd.join(","),
        _i: i,
      };
    });
  }

  companyTxns(c: Company) {
    const r = this.rng(`txn:${c.cif_id}`);
    const rows: { txn_id: number; txn_date: string; dr_cr: "D" | "C"; amount: number; channel: string; counterparty: string; narration: string; balance_after: number; bounced: "Y" | "N" }[] = [];
    let bal = c.avg_balance * between(r, 0.7, 1.2);
    const monthlyCredit = (c.turnover_12m / 12) * (1 - c.gap_pct / 100);
    let id = c.idx * 10000;
    for (let m = c.txn_months - 1; m >= 0; m--) {
      const monthStart = addMonths(AS_OF, -m - 1);
      const n = int(r, 14, 26);
      const credit = monthlyCredit * (1 + between(r, -c.volatility, c.volatility));
      const days = Array.from({ length: n }, () => int(r, 0, 29)).sort((a, b) => a - b);
      for (const d of days) {
        const isCredit = r() < 0.45;
        const amount = round(isCredit ? (credit / (n * 0.45)) * between(r, 0.4, 1.6) : (credit / (n * 0.55)) * between(r, 0.4, 1.5) * 0.98, 1);
        const bounced = !isCredit && r() < c.bounce_ratio;
        if (!bounced) bal += isCredit ? amount : -amount;
        const channel = pick(r, isCredit ? ["NEFT", "RTGS", "IMPS", "UPI", "CHQ"] : ["NEFT", "RTGS", "CHQ", "IMPS", "CASH"]);
        const cp = isCredit
          ? `${pick(r, PREFIX)} ${pick(r, ["Traders", "Industries", "Enterprises", "Exports", "Retail"])}`
          : pick(r, ["GST PAYMENT", "SALARY PAYOUT", "EPFO", "MSEDCL ELECTRICITY", `${pick(r, PREFIX)} Suppliers`, "TDS PAYMENT", "RENT"]);
        rows.push({
          txn_id: ++id,
          txn_date: iso(addDays(monthStart, d)),
          dr_cr: isCredit ? "C" : "D",
          amount,
          channel,
          counterparty: cp,
          narration: bounced ? `CHQ RETURN INSUFF FUNDS ${cp}` : `${channel}/${cp}`.slice(0, 60),
          balance_after: round(bal, 0.01),
          bounced: bounced ? "Y" : "N",
        });
      }
    }
    return rows.reverse();
  }

  gstReturns(c: Company, year: number) {
    const r = this.rng(`gst:${c.gstin}:${year}`);
    const reg = new Date(c.gst_registered_on);
    const out = [];
    for (let mth = 1; mth <= 12; mth++) {
      const period = `${year}-${pad(mth, 2)}`;
      const pDate = new Date(`${period}-01T12:00:00Z`);
      if (pDate < reg || pDate >= addMonths(AS_OF, -1)) continue;
      const due = addDays(addMonths(pDate, 1), 19);
      const growth = Math.pow(0.88, (AS_OF.getFullYear() - year));
      const turnover = round((c.turnover_12m / 12) * growth * between(r, 0.75, 1.25), 1);
      const lateP = c.late_filings_12m / 12;
      const notFiled = c.risk > 0.85 && r() < 0.08;
      const delay = notFiled ? null : r() < lateP ? int(r, 3, 48) : r() < 0.15 ? -int(r, 1, 5) : 0;
      out.push({
        period,
        gstr1_turnover: turnover,
        gstr3b_tax_paid: round(turnover * 0.18 * between(r, 0.92, 1), 1),
        due_date: iso(due),
        filed_on: delay === null ? null : iso(addDays(due, delay)),
        delay_days: delay === null ? null : Math.max(0, delay),
      });
    }
    return out;
  }

  gstYears(c: Company): number[] {
    const first = new Date(c.gst_registered_on).getFullYear();
    const ys: number[] = [];
    for (let y = AS_OF.getFullYear(); y >= first; y--) ys.push(y);
    return ys;
  }

  aaTxns(acct: Partner["aa_accounts"][number]) {
    const r = this.rng(`aa:${acct.aa_account_id}`);
    const rows = [];
    let bal = acct.current_balance;
    let d = AS_OF;
    for (let k = 0; k < 40; k++) {
      d = addDays(d, -int(r, 3, 12));
      const credit = r() < 0.4;
      const amount = round(between(r, 2000, 120000), 1);
      rows.push({
        txn_date: iso(d),
        dr_cr: credit ? "C" : "D",
        amount,
        narration: credit ? pick(r, ["SALARY/NEFT", "DIVIDEND", "IMPS/TRANSFER", "INTEREST CREDIT", "RENT RECEIVED"]) : pick(r, ["UPI/GROCERY", "EMI HOME LOAN", "CC PAYMENT", "SIP MUTUAL FUND", "INSURANCE PREMIUM", "ATM WDL"]),
        balance_after: round(bal, 0.01),
      });
      bal += credit ? -amount : amount;
    }
    return rows;
  }
}

/* ------------------------- decision engine (fixture copy of CREDORA.DECIDE) ------------------------- */

export interface Policy {
  hurdle_pct: number;
  eblr_pct: number;
  max_gst_share_pct: number;
}
export const BASE_POLICY: Policy = { hurdle_pct: 15, eblr_pct: 8.25, max_gst_share_pct: 20 };
const ROI_CAP = 14.5;
const LGD = 0.45;
const CAPITAL = 0.12;
const OPEX = 0.9;

export interface Scored {
  pd: number;
  grade: string;
  decision: Decision;
  roi: number;
  floor_roi: number;
  amount: number;
  max_amount: number;
  tenure: number;
  max_tenure: number;
  raroc: number;
  hard_fail: string | null;
  dscr: number;
  /** fixture copy of CREDORA.ANOMALY: Isolation Forest score, flag (about 3%) and the figures that stand out */
  anomaly: { score: number; flagged: boolean; reasons: string[] };
}

const ANOMALY_REASONS = [
  ["GST turnover far above bank credits", "turnover high for the balances kept"],
  ["Bank credits far above GST turnover", "bank inflows unusually volatile"],
  ["Bank inflows unusually volatile"],
  ["Partner balances at other banks unusually high"],
  ["GST turnover far above bank credits"],
];

function anomalyOf(w: World, c: Company): Scored["anomaly"] {
  const r = w.rng(`anomaly:${c.cif_id}`);
  const flagged = r() < 0.03;
  const score = Math.round((flagged ? between(r, 0.6, 0.71) : between(r, 0.36, 0.58)) * 1000) / 1000;
  return { score, flagged, reasons: flagged ? pick(r, ANOMALY_REASONS) : [] };
}

export function gradeOf(pd: number) {
  const g: [number, string][] = [
    [0.006, "A1"], [0.01, "A2"], [0.016, "A3"], [0.025, "B1"], [0.04, "B2"], [0.065, "B3"], [0.1, "C1"],
  ];
  for (const [cut, name] of g) if (pd < cut) return name;
  return "C2";
}

export function rarocOf(roi: number, pd: number, eblr: number) {
  const cof = eblr - 1.75;
  return ((roi - cof - pd * 100 * LGD - OPEX) / CAPITAL);
}

export function score(w: World, c: Company, modelBias = 0, policy: Policy = BASE_POLICY): Scored {
  const ps = w.partners(c);
  const minScore = Math.min(...ps.map((p) => p.score));
  const r = w.rng(`pd:${c.cif_id}`);
  const pd = Math.min(0.6, Math.max(0.0025, (0.0035 + c.risk * 0.018 + Math.pow(c.risk, 2.2) * 0.2) * between(r, 0.8, 1.2) + modelBias));
  const hard_fail = c.wilful_default
    ? "Wilful default flagged on the CIBIL commercial report"
    : c.cmr_overdue > 0 && c.cmr_rank >= 8
      ? "Overdue on existing facilities with CMR rank 8 or worse"
      : minScore < 600
        ? `Partner CIBIL score ${minScore} is below the 600 cut-off`
        : c.late_filings_12m >= 10
          ? "GST not filed on time for 10 of the last 12 months"
          : null;
  const spread = Math.min(6, 0.4 + pd * 32);
  // operating spread depends on security: secured loans are cheaper to run and to recover
  const opSpread = c.collateral_type === "Property" ? 0.75 : c.collateral_type === "None" ? 1.5 : 1.0;
  const roi = Math.min(ROI_CAP, Math.round((policy.eblr_pct + spread + opSpread) * 20) / 20);
  const monthlyCash = (c.turnover_12m / 12) * 0.11 * (1 - c.gap_pct / 200);
  const tenure = Math.min(c.tenure_requested, c.product === "WC" ? 36 : 60);
  const emiCap = monthlyCash / 1.25;
  const cashAmount = emiCap * annuityFactor(roi, tenure);
  const amount = round(Math.max(0, Math.min(c.amount_requested, (c.turnover_12m * policy.max_gst_share_pct) / 100, cashAmount)), 500000);
  const dscr = Math.round((monthlyCash / Math.max(1, emi(amount || c.amount_requested, roi, tenure))) * 100) / 100;
  const raroc = Math.round(rarocOf(roi, pd, policy.eblr_pct) * 10) / 10;
  // floor ROI: lowest rate where RAROC still meets the hurdle
  const floorRaw = policy.hurdle_pct * CAPITAL + (policy.eblr_pct - 1.75) + pd * 100 * LGD + OPEX;
  const floor_roi = Math.min(roi, Math.ceil(floorRaw * 20) / 20);
  const max_amount = round(Math.min(c.amount_requested * 1.1, (c.turnover_12m * (policy.max_gst_share_pct + 5)) / 100, cashAmount * 1.12), 500000);
  const max_tenure = Math.min(tenure + 12, c.product === "WC" ? 48 : 84);
  let decision: Decision;
  if (hard_fail || pd >= 0.14) decision = "DECLINE";
  else if (raroc >= policy.hurdle_pct && pd < 0.06 && amount >= c.amount_requested * 0.5) decision = "APPROVE";
  else if (raroc >= policy.hurdle_pct * 0.5) decision = "REFER";
  else decision = "DECLINE";
  const anomaly = anomalyOf(w, c);
  if (anomaly.flagged && decision === "APPROVE") decision = "REFER"; // referred for review, never declined on it
  return {
    pd: Math.round(pd * 100000) / 100000,
    grade: gradeOf(pd),
    decision,
    roi,
    floor_roi,
    amount: decision === "DECLINE" ? 0 : amount,
    max_amount: decision === "DECLINE" ? 0 : Math.max(amount, max_amount),
    tenure,
    max_tenure,
    raroc,
    hard_fail,
    dscr,
    anomaly,
  };
}

function annuityFactor(roi: number, n: number) {
  const i = roi / 1200;
  return (1 - Math.pow(1 + i, -n)) / i;
}
export function emi(amount: number, roi: number, n: number) {
  return amount / annuityFactor(roi, n);
}
