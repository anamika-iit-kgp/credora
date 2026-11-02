import { beforeAll, describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  AS_OF,
  BASE_POLICY,
  between,
  type Company,
  DEMO_RM,
  emi,
  gradeOf,
  int,
  iso,
  mulberry32,
  pick,
  type Policy,
  RMS,
  rarocOf,
  round,
  score,
  type Scored,
  World,
} from "./world";

const SEED = 20261031;

describe("seeded random numbers", () => {
  it("repeat exactly for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 20 }, () => a());
    expect(Array.from({ length: 20 }, () => b())).toEqual(xs);
  });

  it("differ for another seed and stay in [0, 1)", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const xs = Array.from({ length: 200 }, () => a());
    expect(xs).not.toEqual(Array.from({ length: 200 }, () => b()));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("helpers stay inside their bounds", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const n = int(r, 2, 5);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
      const x = between(r, 10, 20);
      expect(x).toBeGreaterThanOrEqual(10);
      expect(x).toBeLessThan(20);
      expect(["a", "b", "c"]).toContain(pick(r, ["a", "b", "c"]));
    }
  });

  it("int reaches both ends of an inclusive range", () => {
    const r = mulberry32(3);
    const seen = new Set(Array.from({ length: 400 }, () => int(r, 2, 5)));
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
  });

  it("round snaps to the nearest step", () => {
    expect(round(1_249_999, 500_000)).toBe(1_000_000);
    expect(round(1_250_000, 500_000)).toBe(1_500_000);
    expect(round(7.234, 0.01)).toBeCloseTo(7.23, 10);
  });
});

describe("dates", () => {
  it("the as-of date is 31 October 2026", () => {
    expect(iso(AS_OF)).toBe("2026-10-31");
  });

  it("addDays moves whole days and leaves its input alone", () => {
    expect(iso(addDays(AS_OF, 1))).toBe("2026-11-01");
    expect(iso(addDays(AS_OF, -31))).toBe("2026-09-30");
    expect(iso(AS_OF)).toBe("2026-10-31");
  });

  it("addMonths moves by calendar months and leaves its input alone", () => {
    expect(iso(addMonths(AS_OF, -12))).toBe("2025-10-31");
    expect(iso(addMonths(AS_OF, -24))).toBe("2024-10-31");
    expect(iso(AS_OF)).toBe("2026-10-31");
  });
});

describe("the relationship managers", () => {
  it("are twelve people with unique ids, and the demo RM is one of them", () => {
    expect(RMS).toHaveLength(12);
    expect(new Set(RMS.map((r) => r.rm_id)).size).toBe(12);
    expect(RMS.map((r) => r.rm_id)).toContain(DEMO_RM);
    for (const r of RMS) expect(r.rm_id).toMatch(/^RM\d{3}$/);
  });
});

describe("World", () => {
  let w: World;
  let all: Company[];
  beforeAll(() => {
    w = new World(SEED);
    all = w.all();
  });

  it("holds 1,000 companies by default and as many as asked", () => {
    expect(all).toHaveLength(1000);
    expect(w.size).toBe(1000);
    expect(new World(SEED, 120).all()).toHaveLength(120);
  });

  it("gives every company a unique CIF id, application id and account number in order", () => {
    expect(new Set(all.map((c) => c.cif_id)).size).toBe(1000);
    expect(new Set(all.map((c) => c.app_id)).size).toBe(1000);
    expect(new Set(all.map((c) => c.account_no)).size).toBe(1000);
    expect(all[0].cif_id).toBe("C000001");
    expect(all[999].cif_id).toBe("C001000");
    all.forEach((c, i) => expect(c.idx).toBe(i));
  });

  it("finds a company by CIF id and returns null outside the world", () => {
    expect(w.byCif("C000001")).toBe(all[0]);
    expect(w.byCif("C001000")).toBe(all[999]);
    expect(w.byCif("C001001")).toBeNull();
    expect(w.byCif("C000000")).toBeNull();
    expect(w.byCif("X000001")).toBeNull();
    expect(w.byCif("c000001")).toBeNull();
    expect(w.byCif("")).toBeNull();
  });

  it("is the same world for the same seed and a different one for another seed", () => {
    const again = new World(SEED);
    expect(again.company(17)).toEqual(w.company(17));
    expect(again.partners(again.company(17))).toEqual(w.partners(w.company(17)));
    const other = new World(SEED + 1);
    expect(other.company(17).pan === w.company(17).pan && other.company(17).legal_name === w.company(17).legal_name).toBe(false);
  });

  it("keeps a company object stable between calls", () => {
    expect(w.company(5)).toBe(w.company(5));
  });

  it("writes tax identifiers in the right shape and ties the GSTIN to the PAN", () => {
    for (const c of all) {
      const entity = c.constitution === "LLP" || c.constitution === "Partnership" ? "F" : "C";
      expect(c.pan).toMatch(new RegExp(`^[A-Z]{3}${entity}[A-Z]\\d{4}[A-Z]$`));
      expect(c.gstin).toMatch(/^\d{2}[A-Z]{5}\d{4}[A-Z]1Z[0-9A-Z]$/);
      expect(c.gstin.slice(2, 12)).toBe(c.pan);
    }
  });

  it("assigns every company to one of the twelve RMs", () => {
    const ids = new Set(RMS.map((r) => r.rm_id));
    for (const c of all) expect(ids.has(c.rm_id)).toBe(true);
    expect(new Set(all.map((c) => c.rm_id)).size).toBe(12);
  });

  it("ties the GST stage to the years of filing", () => {
    for (const c of all) {
      expect(c.gst_years).toBeGreaterThanOrEqual(2);
      expect(c.gst_years).toBeLessThanOrEqual(10);
      expect(c.stage).toBe(c.gst_years <= 4 ? "New" : c.gst_years <= 7 ? "Mid-level" : "Stable");
    }
  });

  it("asks for a credit need that is a whole multiple of 5 lakh, with a tenure that fits the product", () => {
    for (const c of all) {
      expect(c.amount_requested).toBeGreaterThan(0);
      expect(c.amount_requested % 500_000).toBe(0);
      expect(["WC", "TL"]).toContain(c.product);
      expect(c.product === "WC" ? [12, 24, 36] : [36, 48, 60, 72, 84]).toContain(c.tenure_requested);
    }
  });

  it("keeps hidden risk, bounce ratio and CMR rank inside their ranges", () => {
    for (const c of all) {
      expect(c.risk).toBeGreaterThanOrEqual(0);
      expect(c.risk).toBeLessThan(1);
      expect(c.cmr_rank).toBeGreaterThanOrEqual(1);
      expect(c.cmr_rank).toBeLessThanOrEqual(10);
      expect(c.late_filings_12m).toBeGreaterThanOrEqual(0);
      expect(c.late_filings_12m).toBeLessThanOrEqual(12);
      expect(c.bounce_ratio).toBeGreaterThanOrEqual(0);
      expect(c.collateral_type === "None" ? c.collateral_value === 0 : c.collateral_value > 0).toBe(true);
    }
  });

  it("gives 2 to 5 partners per company whose shares add up to 100", () => {
    for (const c of all.slice(0, 200)) {
      const ps = w.partners(c);
      expect(ps).toHaveLength(c.partner_count);
      expect(c.partner_count).toBeGreaterThanOrEqual(2);
      expect(c.partner_count).toBeLessThanOrEqual(5);
      expect(ps.reduce((a, p) => a + p.share_pct, 0)).toBeCloseTo(100, 1);
      for (const p of ps) {
        expect(p.cif_id).toBe(c.cif_id);
        expect(p.pan).toMatch(/^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/);
        expect(p.score).toBeGreaterThanOrEqual(420);
        expect(p.score).toBeLessThanOrEqual(890);
        expect(p.aa_accounts.length).toBeGreaterThanOrEqual(1);
        expect(p.aa_accounts.length).toBeLessThanOrEqual(3);
        expect(p.sapphire_acct === null).toBe(!p.sapphire_customer);
      }
    }
  });

  it("names the partners by the company's constitution", () => {
    for (const c of all.slice(0, 200)) {
      const ps = w.partners(c);
      const firm = c.constitution === "Partnership" || c.constitution === "LLP";
      ps.forEach((p, k) => expect(p.role).toBe(firm ? "Partner" : k === 0 ? "Promoter" : "Director"));
    }
  });

  it("gives every partner a unique id across the world", () => {
    const ids = all.flatMap((c) => w.partners(c).map((p) => p.partner_id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds bank transactions newest first, with bounces only on debits", () => {
    const c = all[3];
    const rows = w.companyTxns(c);
    expect(rows.length).toBeGreaterThan(c.txn_months * 10);
    expect(w.companyTxns(c)).toEqual(rows);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].txn_date >= rows[i].txn_date).toBe(true);
    for (const r of rows) if (r.bounced === "Y") expect(r.dr_cr).toBe("D");
  });

  it("builds GST returns only from registration to the month before the as-of date", () => {
    const c = all[3];
    const years = w.gstYears(c);
    expect(years[0]).toBe(AS_OF.getFullYear());
    const rows = years.flatMap((y) => w.gstReturns(c, y));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.period >= c.gst_registered_on.slice(0, 7)).toBe(true);
      expect(r.period < "2026-10").toBe(true);
    }
  });
});

describe("grade, RAROC and EMI", () => {
  it("grades by probability of default, one band per cut-off", () => {
    const cases: [number, string][] = [
      [0.0025, "A1"], [0.0059, "A1"], [0.006, "A2"], [0.0099, "A2"], [0.01, "A3"], [0.0159, "A3"], [0.016, "B1"],
      [0.0249, "B1"], [0.025, "B2"], [0.0399, "B2"], [0.04, "B3"], [0.0649, "B3"], [0.065, "C1"], [0.0999, "C1"], [0.1, "C2"], [0.6, "C2"],
    ];
    for (const [pd, grade] of cases) expect(gradeOf(pd), `pd ${pd}`).toBe(grade);
  });

  it("never gives a better grade to a higher PD", () => {
    const order = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2"];
    let last = 0;
    for (let pd = 0.0025; pd <= 0.6; pd += 0.0005) {
      const g = order.indexOf(gradeOf(pd));
      expect(g).toBeGreaterThanOrEqual(last);
      last = g;
    }
  });

  it("computes RAROC from the rate, the loss and the cost of funds", () => {
    // cost of funds 8.25 - 1.75 = 6.5, expected loss 2 * 0.45 = 0.9, opex 0.9, capital 12%
    expect(rarocOf(12, 0.02, 8.25)).toBeCloseTo((12 - 6.5 - 0.9 - 0.9) / 0.12, 10);
  });

  it("lowers RAROC when the PD rises and raises it when the rate rises", () => {
    expect(rarocOf(12, 0.05, 8.25)).toBeLessThan(rarocOf(12, 0.02, 8.25));
    expect(rarocOf(13, 0.02, 8.25)).toBeGreaterThan(rarocOf(12, 0.02, 8.25));
  });

  it("computes the EMI of a reducing balance loan", () => {
    // 12 lakh at 12% for 12 months is about 1,06,618.55 a month
    expect(emi(1_200_000, 12, 12)).toBeCloseTo(106_618.55, 1);
    expect(emi(1_200_000, 12, 12) * 12).toBeGreaterThan(1_200_000);
    expect(emi(1_200_000, 12, 24)).toBeLessThan(emi(1_200_000, 12, 12));
  });
});

describe("score, the decision engine", () => {
  let w: World;
  let all: Company[];
  let scored: Scored[];
  beforeAll(() => {
    w = new World(SEED);
    all = w.all();
    scored = all.map((c) => score(w, c));
  });

  it("is deterministic", () => {
    expect(score(w, all[10])).toEqual(scored[10]);
    const fresh = new World(SEED);
    expect(fresh.all().slice(0, 25).map((c) => score(fresh, c))).toEqual(scored.slice(0, 25));
  });

  it("returns one of three decisions and the mix adds up to the company count", () => {
    const mix = { APPROVE: 0, REFER: 0, DECLINE: 0 };
    for (const s of scored) mix[s.decision]++;
    expect(mix.APPROVE + mix.REFER + mix.DECLINE).toBe(all.length);
    expect(mix.APPROVE).toBeGreaterThan(0);
    expect(mix.REFER).toBeGreaterThan(0);
    expect(mix.DECLINE).toBeGreaterThan(0);
  });

  it("offers every approved or referred company an amount at or below its credit need", () => {
    scored.forEach((s, i) => {
      if (s.decision === "DECLINE") return;
      expect(s.amount, all[i].cif_id).toBeGreaterThan(0);
      expect(s.amount, all[i].cif_id).toBeLessThanOrEqual(all[i].amount_requested);
      expect(s.amount % 500_000).toBe(0);
    });
  });

  it("sets a negotiation limit at or above the offer on every side", () => {
    scored.forEach((s, i) => {
      if (s.decision === "DECLINE") return;
      const id = all[i].cif_id;
      expect(s.max_amount, id).toBeGreaterThanOrEqual(s.amount);
      expect(s.max_tenure, id).toBeGreaterThanOrEqual(s.tenure);
      expect(s.floor_roi, id).toBeLessThanOrEqual(s.roi);
      expect(s.tenure, id).toBeLessThanOrEqual(all[i].tenure_requested);
    });
  });

  it("keeps the offered rate between the base rate and the cap of 14.5%", () => {
    for (const s of scored) {
      expect(s.roi).toBeGreaterThanOrEqual(BASE_POLICY.eblr_pct);
      expect(s.roi).toBeLessThanOrEqual(14.5);
    }
  });

  it("gives a declined company no offer and no limit", () => {
    const declined = scored.filter((s) => s.decision === "DECLINE");
    expect(declined.length).toBeGreaterThan(0);
    for (const s of declined) {
      expect(s.amount).toBe(0);
      expect(s.max_amount).toBe(0);
    }
  });

  it("declines every company that fails a hard filter, whatever the model says", () => {
    const failed = scored.filter((s) => s.hard_fail);
    expect(failed.length).toBeGreaterThan(0);
    for (const s of failed) expect(s.decision).toBe("DECLINE");
  });

  it("names the hard filter that failed", () => {
    scored.forEach((s, i) => {
      const c = all[i];
      if (c.wilful_default) expect(s.hard_fail).toMatch(/Wilful default/);
      if (s.hard_fail?.startsWith("Partner CIBIL")) expect(Math.min(...w.partners(c).map((p) => p.score))).toBeLessThan(600);
      if (s.hard_fail?.startsWith("GST not filed")) expect(c.late_filings_12m).toBeGreaterThanOrEqual(10);
    });
  });

  it("declines at a PD of 14% or more", () => {
    for (const s of scored) if (s.pd >= 0.14) expect(s.decision).toBe("DECLINE");
  });

  it("approves only on the hurdle, a low PD, a large enough amount and no anomaly flag", () => {
    scored.forEach((s, i) => {
      if (s.decision !== "APPROVE") return;
      expect(s.hard_fail).toBeNull();
      expect(s.raroc).toBeGreaterThanOrEqual(BASE_POLICY.hurdle_pct);
      expect(s.pd).toBeLessThan(0.06);
      expect(s.amount).toBeGreaterThanOrEqual(all[i].amount_requested * 0.5);
      expect(s.anomaly.flagged).toBe(false);
    });
  });

  it("refers rather than approves a company with an anomaly flag", () => {
    const flagged = scored.filter((s) => s.anomaly.flagged);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.length).toBeLessThan(scored.length * 0.08);
    for (const s of flagged) {
      expect(s.decision).not.toBe("APPROVE");
      expect(s.anomaly.reasons.length).toBeGreaterThan(0);
      expect(s.anomaly.score).toBeGreaterThanOrEqual(0.6);
    }
    for (const s of scored.filter((x) => !x.anomaly.flagged)) expect(s.anomaly.reasons).toEqual([]);
  });

  it("keeps the PD between the floor and the cap and matches the grade to it", () => {
    for (const s of scored) {
      expect(s.pd).toBeGreaterThanOrEqual(0.0025);
      expect(s.pd).toBeLessThanOrEqual(0.6);
      expect(s.grade).toBe(gradeOf(s.pd));
    }
  });

  it("approves fewer companies when the model is more pessimistic", () => {
    const count = (bias: number) => all.filter((c) => score(w, c, bias).decision === "APPROVE").length;
    expect(count(0.02)).toBeLessThanOrEqual(count(0));
    expect(count(0)).toBeLessThanOrEqual(count(-0.01));
    expect(count(0.02)).toBeLessThan(count(-0.01));
  });

  it("approves fewer companies when the hurdle goes up, and never prices the floor lower", () => {
    const strict: Policy = { ...BASE_POLICY, hurdle_pct: 25 };
    const approvals = (p: Policy) => all.filter((c) => score(w, c, 0, p).decision === "APPROVE").length;
    expect(approvals(strict)).toBeLessThan(approvals(BASE_POLICY));
    const idx = scored.findIndex((s) => s.decision !== "DECLINE" && s.floor_roi < s.roi);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(score(w, all[idx], 0, strict).floor_roi).toBeGreaterThanOrEqual(scored[idx].floor_roi);
  });

  it("offers a smaller amount when the policy caps the share of GST turnover lower", () => {
    const tight: Policy = { ...BASE_POLICY, max_gst_share_pct: 5 };
    scored.forEach((s, i) => {
      if (i % 10) return;
      expect(score(w, all[i], 0, tight).amount).toBeLessThanOrEqual(s.amount);
    });
  });
});
