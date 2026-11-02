import { beforeAll, describe, expect, it } from "vitest";
import { buildFeatures, buildReasons, buildSteps } from "./report";
import { type Company, score, type Scored, World } from "./world";

const RUN = "R20261031-01";

describe("report building blocks", () => {
  let w: World;
  let all: Company[];
  let scored: Scored[];
  let approved: number;
  let hardFailed: number;
  let flagged: number;

  beforeAll(() => {
    w = new World(20261031);
    all = w.all();
    scored = all.map((c) => score(w, c));
    approved = scored.findIndex((s) => s.decision === "APPROVE");
    hardFailed = scored.findIndex((s) => s.hard_fail);
    flagged = scored.findIndex((s) => s.anomaly.flagged);
  });

  describe("buildSteps", () => {
    it("lists the pipeline steps numbered 1 to n in order", () => {
      const steps = buildSteps(all[approved], scored[approved], 3, RUN);
      expect(steps.length).toBeGreaterThanOrEqual(10);
      steps.forEach((st, i) => expect(st.n).toBe(i + 1));
    });

    it("gives every step a name, an explanation, an object, code and its sources", () => {
      for (const st of buildSteps(all[approved], scored[approved], 3, RUN)) {
        expect(st.name.length).toBeGreaterThan(0);
        expect(st.what.length).toBeGreaterThan(0);
        expect(st.object.length).toBeGreaterThan(0);
        expect(st.code.length).toBeGreaterThan(0);
        expect(st.sources.length).toBeGreaterThan(0);
        expect(["sql", "lua", "python"]).toContain(st.language);
        expect(st.ms === null || st.ms > 0).toBe(true);
      }
    });

    it("gives every step its own name", () => {
      const names = buildSteps(all[approved], scored[approved], 3, RUN).map((st) => st.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it("puts the company's CIF id and the run id into the code of the steps", () => {
      const c = all[approved];
      const code = buildSteps(c, scored[approved], 3, RUN).map((st) => st.code).join("\n");
      expect(code).toContain(`'${c.cif_id}'`);
      expect(code).toContain(`'${RUN}'`);
    });

    it("trims leading and trailing blank lines from the code", () => {
      for (const st of buildSteps(all[approved], scored[approved], 3, RUN)) {
        expect(st.code.startsWith("\n")).toBe(false);
        expect(st.code).toBe(st.code.trimEnd());
      }
    });

    it("says the hard filters failed, and why, for a company that fails one", () => {
      expect(hardFailed).toBeGreaterThanOrEqual(0);
      const s = scored[hardFailed];
      const step = buildSteps(all[hardFailed], s, 3, RUN).find((x) => x.name === "Apply hard filters");
      expect(step?.what).toContain("Failed.");
      expect(step?.what).toContain(s.hard_fail ?? "");
      expect(step?.what).toContain("declined whatever the model says");
    });

    it("says the hard filters passed for a company that fails none", () => {
      const step = buildSteps(all[approved], scored[approved], 3, RUN).find((x) => x.name === "Apply hard filters");
      expect(step?.what.startsWith("Passed.")).toBe(true);
    });

    it("tells a flagged company it is referred, never declined, on the anomaly", () => {
      expect(flagged).toBeGreaterThanOrEqual(0);
      const step = buildSteps(all[flagged], scored[flagged], 3, RUN).find((x) => x.name.startsWith("Flag unusual"));
      expect(step?.what).toContain("Flagged for");
      expect(step?.what).toContain("referred for review, never declined on it");
    });

    it("tells an unflagged company that it was not flagged, with the score", () => {
      const s = scored[approved];
      const step = buildSteps(all[approved], s, 3, RUN).find((x) => x.name.startsWith("Flag unusual"));
      expect(step?.what).toContain("Not flagged");
      expect(step?.what).toContain(s.anomaly.score.toFixed(3));
    });

    it("shows the PD as a percentage and the grade in the scoring step", () => {
      const s = scored[approved];
      const step = buildSteps(all[approved], s, 3, RUN).find((x) => x.name.startsWith("Score risk"));
      expect(step?.what).toContain(`PD ${(s.pd * 100).toFixed(2)}%`);
      expect(step?.what).toContain(`grade ${s.grade}`);
    });

    it("counts the partners in the CIBIL step", () => {
      const step = buildSteps(all[approved], scored[approved], 4, RUN).find((x) => x.name.startsWith("Fetch CIBIL"));
      expect(step?.code).toContain("4 partners");
    });
  });

  describe("buildFeatures", () => {
    it("returns the thirteen features once each, with a label and a source", () => {
      const fs = buildFeatures(all[approved], w, scored[approved]);
      expect(fs).toHaveLength(13);
      expect(new Set(fs.map((f) => f.name)).size).toBe(13);
      for (const f of fs) {
        expect(f.label.length).toBeGreaterThan(0);
        expect(f.source.length).toBeGreaterThan(0);
      }
    });

    it("takes its values from the company, its partners and the score", () => {
      const c = all[approved];
      const s = scored[approved];
      const byName = Object.fromEntries(buildFeatures(c, w, s).map((f) => [f.name, f.value]));
      const ps = w.partners(c);
      expect(byName.gst_years).toBe(c.gst_years);
      expect(byName.gst_turnover_12m).toBe(c.turnover_12m);
      expect(byName.cmr_rank).toBe(c.cmr_rank);
      expect(byName.dscr).toBe(s.dscr);
      expect(byName.partner_min_score).toBe(Math.min(...ps.map((p) => p.score)));
      expect(byName.partner_overdue_amt).toBe(ps.reduce((a, p) => a + p.overdue, 0));
      expect(byName.partner_other_bank_bal).toBe(ps.reduce((a, p) => a + p.aa_accounts.reduce((b, x) => b + x.current_balance, 0), 0));
    });

    it("keeps the average partner score between the lowest and the highest", () => {
      for (const i of [0, 1, 2, 3, 4, 5]) {
        const byName = Object.fromEntries(buildFeatures(all[i], w, scored[i]).map((f) => [f.name, f.value]));
        const scores = w.partners(all[i]).map((p) => p.score);
        expect(byName.partner_avg_score as number).toBeGreaterThanOrEqual(Math.min(...scores));
        expect(byName.partner_avg_score as number).toBeLessThanOrEqual(Math.max(...scores));
      }
    });
  });

  describe("buildReasons", () => {
    it("returns at most six reasons, strongest first", () => {
      for (const i of [0, 1, 2, 3, 4, 5, hardFailed, flagged]) {
        const rs = buildReasons(all[i], w);
        expect(rs.length).toBeGreaterThan(0);
        expect(rs.length).toBeLessThanOrEqual(6);
        for (let k = 1; k < rs.length; k++) expect(Math.abs(rs[k - 1].contribution)).toBeGreaterThanOrEqual(Math.abs(rs[k].contribution));
      }
    });

    it("names each feature once and writes a sentence for it", () => {
      const rs = buildReasons(all[approved], w);
      expect(new Set(rs.map((r) => r.feature)).size).toBe(rs.length);
      for (const r of rs) expect(r.text.length).toBeGreaterThan(10);
    });

    it("rounds contributions to three decimals", () => {
      for (const r of buildReasons(all[approved], w)) expect(Math.round(r.contribution * 1000) / 1000).toBe(r.contribution);
    });

    it("pushes a company with a wide GST gap towards risk and a clean one away from it", () => {
      const wide = all.find((c) => c.gap_pct > 30);
      const tight = all.find((c) => c.gap_pct < 6);
      expect(wide).toBeDefined();
      expect(tight).toBeDefined();
      const gap = (c: Company) => buildReasons(c, w).find((r) => r.feature === "gst_bank_gap_pct");
      expect(gap(wide!)).toBeDefined();
      expect(gap(wide!)!.contribution).toBeGreaterThan(0);
      expect(gap(tight!)).toBeDefined();
      expect(gap(tight!)!.contribution).toBeLessThan(0);
    });
  });
});
