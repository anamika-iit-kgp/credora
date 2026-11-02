// The in-browser fixture server end to end: the decisions, the offers, the Top 50, the report and the RM's book,
// read through the same /api paths the app calls. Every reply is computed from the seeded world, so the numbers are stable.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RlsProofRow } from "../api/exasol";
import type {
  Assignment,
  AuditEntry,
  CompanyRow,
  Decision,
  DecisionMix,
  DecisionRow,
  LoanStatusRow,
  Offer,
  Overview,
  Page,
  Report,
  Role,
  Run,
  Top50Row,
  User,
} from "../api/types";
import { can, type Permission } from "../lib/roles";
import { bootFixtures, call, detail, freshFixtures, get, post, request } from "../test/fixtureApi";
import { BASE_POLICY, type Company, DEMO_RM, RMS, score, type Scored, World } from "./world";

const SEED = 20261031;
const ROLES: Role[] = ["admin", "datasci", "loanops", "rm"];
const DECISIONS: Decision[] = ["APPROVE", "REFER", "DECLINE"];

let world: World;
let scored: Scored[];

beforeAll(() => {
  bootFixtures();
  freshFixtures();
  world = new World(SEED);
  scored = world.all().map((c) => score(world, c, 0, BASE_POLICY));
});

/** Every page of /api/decisions, in rank order. */
async function allDecisions(query = "") {
  const rows: DecisionRow[] = [];
  for (let page = 1; ; page++) {
    const r = await get<Page<DecisionRow>>("admin", `/api/decisions?page=${page}${query}`);
    rows.push(...r.body.items);
    if (rows.length >= r.body.total || !r.body.items.length) return rows;
  }
}

describe("signing in", () => {
  it("answers the four demo users with a token and their role", async () => {
    for (const role of ROLES) {
      const r = await post<{ token: string; user: User }>(null, "/api/auth/login", { username: role, password: "anything" });
      expect(r.status).toBe(200);
      expect(r.body.token).toBe(`fx.${role}`);
      expect(r.body.user.role).toBe(role);
      expect(r.body.user.username).toBe(role);
    }
  });

  it("ignores the case of the user name and refuses an unknown user or an empty password", async () => {
    expect((await post<{ user: User }>(null, "/api/auth/login", { username: "ADMIN", password: "x" })).body.user.role).toBe("admin");
    const unknown = await post(null, "/api/auth/login", { username: "nobody", password: "x" });
    expect(unknown.status).toBe(401);
    expect(detail(unknown)).toBe("Wrong username or password.");
    expect((await post(null, "/api/auth/login", { username: "rm", password: "" })).status).toBe(401);
  });

  it("asks anyone without a valid token to sign in", async () => {
    expect((await get(null, "/api/me")).status).toBe(401);
    expect(detail(await get(null, "/api/top50"))).toBe("Sign in to continue.");
    expect((await request({ Authorization: "Bearer fx.hacker" }, "GET", "/api/me")).status).toBe(401);
    expect((await request({ Authorization: "Basic fx.admin" }, "GET", "/api/me")).status).toBe(401);
  });

  it("returns the signed-in user with the role of the token", async () => {
    for (const role of ROLES) expect((await get<User>(role, "/api/me")).body.role).toBe(role);
  });

  it("answers an unknown path with 404", async () => {
    const r = await get("admin", "/api/no-such-thing");
    expect(r.status).toBe(404);
    expect(detail(r)).toContain("No fixture for GET /api/no-such-thing");
  });
});

describe("role gates in the fixture server follow the UI permissions", () => {
  // [permissions that open the path, method, path]
  const reads: [Permission[], string][] = [
    [["decisions"], "/api/decisions"],
    [["top50"], "/api/top50"],
    [["runs"], "/api/runs"],
    [["models"], "/api/ml/models"],
    [["offers"], "/api/offers"],
    [["audit"], "/api/admin/audit"],
    [["sources"], "/api/admin/sources"],
    [["approvePolicy"], "/api/approvals/pending"],
    [["whatif"], "/api/whatif/runs"],
    [["requestActivation", "approveModels"], "/api/ml/activation-requests"],
  ];

  it.each(reads)("%j opens GET %s for exactly the roles that hold it", async (perms, path) => {
    for (const role of ROLES) {
      const allowed = perms.some((p) => can(role, p));
      const r = await get(role, path);
      expect(r.status === 403, `${role} on ${path} got ${r.status}`).toBe(!allowed);
      if (!allowed) expect(detail(r)).toBe(`The ${role} role cannot use this endpoint.`);
    }
  });

  const writes: [Permission, string][] = [
    ["generate", "/api/admin/generate"],
    ["runAnalysis", "/api/analysis/run"],
    ["train", "/api/ml/train"],
    ["publish", "/api/runs/R20261031-01/publish"],
    ["assign", "/api/assignments"],
    ["logStatus", "/api/loan-status/C000001"],
    ["requestActivation", "/api/ml/activation-requests"],
  ];

  it.each(writes)("%s: POST %s is refused to every role without it", async (perm, path) => {
    for (const role of ROLES) {
      if (can(role, perm)) continue;
      const r = await post(role, path, {});
      expect(r.status, `${role} on ${path}`).toBe(403);
    }
  });
});

describe("overview and decisions", () => {
  it("counts 1,000 companies and a decision mix that adds up to them", async () => {
    const ov = await get<Overview>("admin", "/api/overview");
    expect(ov.status).toBe(200);
    expect(ov.body.counts.companies).toBe(1000);
    const m = ov.body.decision_mix as DecisionMix;
    expect(m.APPROVE + m.REFER + m.DECLINE).toBe(ov.body.counts.companies);
  });

  it("matches the decision mix to the pure decision engine", async () => {
    const ov = await get<Overview>("admin", "/api/overview");
    const expected = { APPROVE: 0, REFER: 0, DECLINE: 0 };
    for (const s of scored) expected[s.decision]++;
    expect(ov.body.decision_mix).toEqual(expected);
  });

  it("pages the decisions 50 at a time and ranks every company once, 1 to 1000", async () => {
    const first = await get<Page<DecisionRow>>("admin", "/api/decisions");
    expect(first.body.total).toBe(1000);
    expect(first.body.size).toBe(50);
    expect(first.body.items).toHaveLength(50);
    const rows = await allDecisions();
    expect(rows).toHaveLength(1000);
    expect(rows.map((r) => r.rank_no)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
    expect(new Set(rows.map((r) => r.cif_id)).size).toBe(1000);
  });

  it("ranks approvals first, then referrals, then declines", async () => {
    const rows = await allDecisions();
    const order: Record<Decision, number> = { APPROVE: 0, REFER: 1, DECLINE: 2 };
    for (let i = 1; i < rows.length; i++) expect(order[rows[i].decision]).toBeGreaterThanOrEqual(order[rows[i - 1].decision]);
  });

  it("filters by decision and the filtered totals add up to the whole", async () => {
    const mix = (await get<Overview>("admin", "/api/overview")).body.decision_mix as DecisionMix;
    let sum = 0;
    for (const d of DECISIONS) {
      const r = await get<Page<DecisionRow>>("admin", `/api/decisions?decision=${d}`);
      expect(r.body.total).toBe(mix[d]);
      for (const row of r.body.items) expect(row.decision).toBe(d);
      sum += r.body.total;
    }
    expect(sum).toBe(1000);
  });

  it("filters by grade", async () => {
    const r = await get<Page<DecisionRow>>("admin", "/api/decisions?grade=A1");
    expect(r.body.total).toBeGreaterThan(0);
    for (const row of r.body.items) expect(row.grade).toBe("A1");
  });

  it("gives approved and referred rows an offer and declined rows none", async () => {
    for (const row of await allDecisions()) {
      if (row.decision === "DECLINE") {
        expect(row.offer_amount).toBeNull();
        expect(row.offer_roi).toBeNull();
        expect(row.offer_tenure).toBeNull();
      } else {
        expect(row.offer_amount).toBeGreaterThan(0);
        expect(row.offer_roi).toBeGreaterThan(0);
        expect(row.offer_tenure).toBeGreaterThan(0);
      }
    }
  });

  it("splits the companies into assigned and not assigned", async () => {
    const yes = await get<Page<DecisionRow>>("admin", "/api/decisions?assigned=yes");
    const no = await get<Page<DecisionRow>>("admin", "/api/decisions?assigned=no");
    expect(yes.body.total).toBe(43);
    expect(yes.body.total + no.body.total).toBe(1000);
    for (const row of yes.body.items) expect(row.assigned_rm_id).toBeTruthy();
    for (const row of no.body.items) expect(row.assigned_rm_id).toBeNull();
  });
});

describe("Top 50", () => {
  it("has 50 rows ranked 1 to 50, in order", async () => {
    const r = await get<Top50Row[]>("loanops", "/api/top50");
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(50);
    expect(r.body.map((x) => x.rank_no)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(r.body.map((x) => x.cif_id)).size).toBe(50);
  });

  it("is the first 50 of the decisions list, all approvals with an offer", async () => {
    const top = (await get<Top50Row[]>("admin", "/api/top50")).body;
    const dec = (await get<Page<DecisionRow>>("admin", "/api/decisions")).body.items;
    expect(top.map((x) => x.cif_id)).toEqual(dec.map((x) => x.cif_id));
    dec.forEach((d, i) => {
      expect(d.decision).toBe("APPROVE");
      expect(top[i].offer_amount).toBe(d.offer_amount);
      expect(top[i].pd).toBe(d.pd);
      expect(top[i].grade).toBe(d.grade);
    });
    for (const row of top) expect(row.offer_amount).toBeGreaterThan(0);
  });

  it("is the same for the admin, the data scientist and loan operations", async () => {
    const a = (await get<Top50Row[]>("admin", "/api/top50")).body.map((x) => x.cif_id);
    expect((await get<Top50Row[]>("datasci", "/api/top50")).body.map((x) => x.cif_id)).toEqual(a);
    expect((await get<Top50Row[]>("loanops", "/api/top50")).body.map((x) => x.cif_id)).toEqual(a);
  });

  it("names the RM a company was assigned to, as the assignments list does", async () => {
    const top = (await get<Top50Row[]>("loanops", "/api/top50")).body;
    const assigned = Object.fromEntries((await get<Assignment[]>("loanops", "/api/assignments")).body.map((a) => [a.cif_id, a.rm_id]));
    for (const row of top) expect(row.assigned_rm_id ?? null).toBe(assigned[row.cif_id] ?? null);
    expect(top.some((r) => r.assigned_rm_id === DEMO_RM)).toBe(true);
  });

  it("is closed to the relationship manager", async () => {
    expect((await get("rm", "/api/top50")).status).toBe(403);
  });
});

describe("offers", () => {
  let offers: Offer[];
  beforeAll(async () => {
    offers = (await get<Offer[]>("loanops", "/api/offers")).body;
  });

  it("exist for every approved and referred company and for no declined one", () => {
    const withOffer = new Set(offers.map((o) => o.cif_id));
    const all = world.all();
    expect(offers).toHaveLength(scored.filter((s) => s.decision !== "DECLINE").length);
    all.forEach((c, i) => expect(withOffer.has(c.cif_id), c.cif_id).toBe(scored[i].decision !== "DECLINE"));
  });

  it("offer an amount at or below the credit need, with a limit at or above the offer", () => {
    for (const o of offers) {
      const c = world.byCif(o.cif_id) as Company;
      expect(o.offer_amount, o.cif_id).toBeGreaterThan(0);
      expect(o.offer_amount as number, o.cif_id).toBeLessThanOrEqual(c.amount_requested);
      expect(o.max_amount as number, o.cif_id).toBeGreaterThanOrEqual(o.offer_amount as number);
      expect(o.max_tenure as number, o.cif_id).toBeGreaterThanOrEqual(o.offer_tenure as number);
      expect(o.floor_roi as number, o.cif_id).toBeLessThanOrEqual(o.offer_roi as number);
    }
  });

  it("carry the terms the decision engine worked out", () => {
    for (const o of offers) {
      const s = scored[Number(o.cif_id.slice(1)) - 1];
      expect(o.decision).toBe(s.decision);
      expect(o.offer_amount).toBe(s.amount);
      expect(o.offer_roi).toBe(s.roi);
      expect(o.offer_tenure).toBe(s.tenure);
      expect(o.max_amount).toBe(s.max_amount);
      expect(o.floor_roi).toBe(s.floor_roi);
      expect(o.grade).toBe(s.grade);
    }
  });

  it("are listed by rank, with ids that count from 1 like the companies", () => {
    for (let i = 1; i < offers.length; i++) expect(offers[i].rank_no as number).toBeGreaterThanOrEqual(offers[i - 1].rank_no as number);
    for (const o of offers) expect(o.offer_id).toBe(Number(o.cif_id.slice(1)));
  });

  it("have agreed terms from the first negotiation on, and none while only offered", () => {
    for (const o of offers) {
      if (o.stage === "OFFERED") {
        expect(o.agreed_amount).toBeNull();
        expect(o.agreed_roi).toBeNull();
        expect(o.agreed_tenure).toBeNull();
      } else {
        expect(o.agreed_amount).not.toBeNull();
        expect(o.agreed_roi).not.toBeNull();
        expect(o.agreed_tenure).not.toBeNull();
      }
    }
  });

  it("show terms inside the limit for verified and sanctioned offers and outside it for escalated ones", () => {
    for (const o of offers) {
      const within =
        (o.agreed_amount ?? 0) <= (o.max_amount ?? 0) && (o.agreed_roi ?? 0) >= (o.floor_roi ?? 0) && (o.agreed_tenure ?? 0) <= (o.max_tenure ?? 0);
      if (o.stage === "VERIFIED" || o.stage === "SANCTIONED" || o.stage === "NEGOTIATING") expect(within, `${o.cif_id} ${o.stage}`).toBe(true);
      if (o.stage === "ESCALATED") expect(within, o.cif_id).toBe(false);
    }
  });

  it("filter by stage", async () => {
    const r = await get<Offer[]>("loanops", "/api/offers?stage=SANCTIONED,VERIFIED");
    expect(r.body.length).toBeGreaterThan(0);
    for (const o of r.body) expect(["SANCTIONED", "VERIFIED"]).toContain(o.stage);
    expect(r.body.length).toBe(offers.filter((o) => o.stage === "SANCTIONED" || o.stage === "VERIFIED").length);
  });

  it("are closed to the data scientist and open to the admin", async () => {
    expect((await get("datasci", "/api/offers")).status).toBe(403);
    expect((await get<Offer[]>("admin", "/api/offers")).body).toHaveLength(offers.length);
  });
});

describe("the report", () => {
  it("gives an approved company its offer inside its limit", async () => {
    const top = (await get<Top50Row[]>("admin", "/api/top50")).body[0];
    const r = await get<Report>("admin", `/api/companies/${top.cif_id}/report`);
    expect(r.status).toBe(200);
    const rep = r.body;
    expect(rep.cif_id).toBe(top.cif_id);
    expect(rep.decision).toBe("APPROVE");
    expect(rep.rank_no).toBe(1);
    expect(rep.rank_of).toBe(1000);
    expect(rep.offer).not.toBeNull();
    expect(rep.limit).not.toBeNull();
    expect(rep.offer!.amount).toBeLessThanOrEqual(rep.requested.amount);
    expect(rep.limit!.max_amount).toBeGreaterThanOrEqual(rep.offer!.amount);
    expect(rep.limit!.max_tenure).toBeGreaterThanOrEqual(rep.offer!.tenure);
    expect(rep.limit!.floor_roi).toBeLessThanOrEqual(rep.offer!.roi);
    expect(rep.offer_id).toBe(Number(top.cif_id.slice(1)));
    expect(rep.offer!.amount).toBe(top.offer_amount);
  });

  it("explains itself with numbered steps, thirteen features, up to six reasons and the pricing inputs", async () => {
    const rep = (await get<Report>("admin", "/api/companies/C000631/report")).body;
    rep.steps.forEach((s, i) => expect(s.n).toBe(i + 1));
    expect(rep.features).toHaveLength(13);
    expect(rep.reasons.length).toBeGreaterThan(0);
    expect(rep.reasons.length).toBeLessThanOrEqual(6);
    expect(rep.sources_used).toContain("exasol");
    expect(rep.pricing).not.toBeNull();
    expect(rep.pricing!.lgd_pct).toBeGreaterThanOrEqual(35);
    expect(rep.pricing!.lgd_pct).toBeLessThanOrEqual(45);
    expect(rep.pricing!.exposure_room).toBeGreaterThanOrEqual(0);
  });

  it("gives a refused company the refusal and no offer, no limit and no offer id", async () => {
    const i = scored.findIndex((s) => s.decision === "DECLINE" && s.hard_fail);
    expect(i).toBeGreaterThanOrEqual(0);
    const c = world.company(i);
    const rep = (await get<Report>("admin", `/api/companies/${c.cif_id}/report`)).body;
    expect(rep.decision).toBe("DECLINE");
    expect(rep.offer).toBeNull();
    expect(rep.limit).toBeNull();
    expect(rep.offer_id).toBeNull();
    expect(rep.hard_fails).toContain(scored[i].hard_fail);
    expect(rep.requested.amount).toBe(c.amount_requested);
    const hardFilter = rep.steps.find((s) => s.name === "Apply hard filters");
    expect(hardFilter?.what).toContain("Failed.");
  });

  it("refuses a company with no hard filter on its numbers alone, without a hard-fail reason", async () => {
    const i = scored.findIndex((s) => s.decision === "DECLINE" && !s.hard_fail && !s.anomaly.flagged);
    expect(i).toBeGreaterThanOrEqual(0);
    const rep = (await get<Report>("admin", `/api/companies/${world.company(i).cif_id}/report`)).body;
    expect(rep.decision).toBe("DECLINE");
    expect(rep.offer).toBeNull();
    expect(rep.hard_fails).toEqual([]);
  });

  it("carries the anomaly reason of a flagged company in the hard fails", async () => {
    const i = scored.findIndex((s) => s.anomaly.flagged && !s.hard_fail);
    expect(i).toBeGreaterThanOrEqual(0);
    const rep = (await get<Report>("admin", `/api/companies/${world.company(i).cif_id}/report`)).body;
    expect(rep.decision).not.toBe("APPROVE");
    expect(rep.hard_fails?.some((f) => f.startsWith("Anomaly: "))).toBe(true);
    expect(rep.anomaly?.flagged).toBe(true);
  });

  it("hides the anomaly score from the relationship manager", async () => {
    const mine = (await get<Assignment[]>("rm", "/api/assignments")).body[0].cif_id;
    const asRm = (await get<Report>("rm", `/api/companies/${mine}/report`)).body;
    const asAdmin = (await get<Report>("admin", `/api/companies/${mine}/report`)).body;
    expect(asRm.anomaly).toBeNull();
    expect(asAdmin.anomaly).not.toBeNull();
    expect(asRm.decision).toBe(asAdmin.decision);
    expect(asRm.offer).toEqual(asAdmin.offer);
  });

  it("answers an unknown CIF id with 404", async () => {
    for (const cif of ["C009999", "C000000", "nonsense"]) expect((await get("admin", `/api/companies/${cif}/report`)).status).toBe(404);
  });

  it("records who read the report in the audit log", async () => {
    await get("loanops", "/api/companies/C000002/report");
    const log = (await get<AuditEntry[]>("admin", "/api/admin/audit?limit=20")).body;
    expect(log.some((e) => e.action === "VIEW_REPORT" && e.target === "C000002" && e.role === "loanops")).toBe(true);
  });
});

describe("the relationship manager's book", () => {
  let book: Assignment[];
  let bookCifs: Set<string>;
  beforeAll(async () => {
    book = (await get<Assignment[]>("rm", "/api/assignments")).body;
    bookCifs = new Set(book.map((a) => a.cif_id));
  });

  it("holds only companies assigned to RM001, 25 of them from the seeded Top 50", async () => {
    expect(book).toHaveLength(25);
    for (const a of book) expect(a.rm_id).toBe(DEMO_RM);
    const top = new Set((await get<Top50Row[]>("loanops", "/api/top50")).body.map((r) => r.cif_id));
    for (const cif of bookCifs) expect(top.has(cif)).toBe(true);
  });

  it("is a part of what loan operations sees across all managers", async () => {
    const all = (await get<Assignment[]>("loanops", "/api/assignments")).body;
    expect(all.length).toBeGreaterThan(book.length);
    expect(new Set(all.map((a) => a.rm_id)).size).toBeGreaterThan(1);
    const known = new Set(RMS.map((r) => r.rm_id));
    for (const a of all) expect(known.has(a.rm_id)).toBe(true);
    expect(all.filter((a) => a.rm_id === DEMO_RM)).toHaveLength(book.length);
  });

  it("filters the company list to the manager's companies", async () => {
    const mine = (await get<Page<CompanyRow>>("rm", "/api/companies?size=200")).body;
    expect(mine.total).toBe(25);
    expect(new Set(mine.items.map((r) => r.cif_id))).toEqual(bookCifs);
    for (const r of mine.items) expect(r.rm_id).toBe(DEMO_RM);
    expect((await get<Page<CompanyRow>>("admin", "/api/companies")).body.total).toBe(1000);
  });

  it("counts only the manager's companies on the overview, all of them approved", async () => {
    const ov = (await get<Overview>("rm", "/api/overview")).body;
    expect(ov.counts.companies).toBe(25);
    expect(ov.counts.applications).toBe(25);
    const m = ov.decision_mix as DecisionMix;
    expect(m.APPROVE + m.REFER + m.DECLINE).toBe(25);
    expect(m.DECLINE).toBe(0);
  });

  it("lists only the manager's offers", async () => {
    const offers = (await get<Offer[]>("rm", "/api/offers")).body;
    expect(offers).toHaveLength(25);
    for (const o of offers) expect(bookCifs.has(o.cif_id)).toBe(true);
  });

  it("tracks loan status only for the manager's companies", async () => {
    const mine = (await get<LoanStatusRow[]>("rm", "/api/loan-status")).body;
    expect(new Set(mine.map((r) => r.cif_id))).toEqual(bookCifs);
    for (const r of mine) expect(r.rm_id).toBe(DEMO_RM);
    const all = (await get<LoanStatusRow[]>("loanops", "/api/loan-status")).body;
    expect(all.length).toBeGreaterThan(mine.length);
  });

  it("opens the report and the tree of an assigned company and refuses any other", async () => {
    const mine = book[0].cif_id;
    expect((await get("rm", `/api/companies/${mine}/report`)).status).toBe(200);
    expect((await get("rm", `/api/companies/${mine}/tree`)).status).toBe(200);
    const other = world.all().find((c) => !bookCifs.has(c.cif_id))!;
    for (const path of [`/api/companies/${other.cif_id}/report`, `/api/companies/${other.cif_id}/tree`]) {
      const r = await get("rm", path);
      expect(r.status).toBe(403);
      expect(detail(r)).toBe(`${other.cif_id} is not assigned to you.`);
    }
  });

  it("keeps the rest of the bank closed to the manager", async () => {
    for (const path of ["/api/decisions", "/api/top50", "/api/rms", "/api/runs"]) expect((await get("rm", path)).status).toBe(403);
  });

  it("agrees with the row-level security proof, which counts the manager's rows per published run", async () => {
    const proof = (await get<RlsProofRow[]>("admin", "/api/admin/rls-proof")).body;
    const published = (await get<Run[]>("admin", "/api/runs")).body.filter((r) => r.published).length;
    const own = proof.filter((r) => (r.exa_user === "CREDORA_RM" || r.exa_user === "CREDORA_RM_AI") && r.sql.includes("V_RM_DECISIONS"));
    expect(own).toHaveLength(2);
    for (const r of own) expect(r.rows).toBe(book.length * published);
    const other = proof.find((r) => r.exa_user === "CREDORA_RM002");
    expect(other?.rows).toBeGreaterThan(0);
    const direct = proof.find((r) => r.sql.includes("CREDORA.DECISIONS"));
    expect(direct?.rows).toBeNull();
    expect(direct?.error).toContain("insufficient privileges");
  });
});

describe("assigning companies to relationship managers", () => {
  beforeEach(() => {
    freshFixtures();
  });

  it("is for loan operations only", async () => {
    for (const role of ["admin", "datasci", "rm"] as const) expect((await post(role, "/api/assignments", { cif_ids: ["C000001"], rm_id: "RM002" })).status).toBe(403);
  });

  it("refuses an unknown manager, an empty list and a company that does not exist", async () => {
    const noRm = await post("loanops", "/api/assignments", { cif_ids: ["C000001"], rm_id: "RM999" });
    expect(noRm.status).toBe(422);
    expect(detail(noRm)).toContain("No relationship manager RM999");
    expect((await post("loanops", "/api/assignments", { cif_ids: [], rm_id: "RM002" })).status).toBe(422);
    const missing = await post("loanops", "/api/assignments", { cif_ids: ["C999999"], rm_id: "RM002" });
    expect(missing.status).toBe(404);
  });

  it("adds a new company to the manager's book with an Assigned status", async () => {
    const before = new Set((await get<Assignment[]>("rm", "/api/assignments")).body.map((a) => a.cif_id));
    const target = world.all().find((c, i) => scored[i].decision !== "DECLINE" && !before.has(c.cif_id))!;
    const r = await post<{ rm_id: string; assigned: number; moved: number; unchanged: number }>("loanops", "/api/assignments", {
      cif_ids: [target.cif_id.toLowerCase()],
      rm_id: DEMO_RM,
    });
    expect(r.body).toEqual({ rm_id: DEMO_RM, assigned: 1, moved: 0, unchanged: 0 });
    const after = (await get<Assignment[]>("rm", "/api/assignments")).body;
    expect(after).toHaveLength(before.size + 1);
    expect(after.some((a) => a.cif_id === target.cif_id && a.assigned_by === "loanops")).toBe(true);
    const row = (await get<LoanStatusRow[]>("rm", "/api/loan-status")).body.find((x) => x.cif_id === target.cif_id);
    expect(row?.status).toBe("ASSIGNED");
    expect(row?.history[0].note).toBe(`Assigned to ${DEMO_RM}`);
  });

  it("counts a repeat as unchanged and a hand-over as moved, and takes the company out of the old book", async () => {
    const mine = (await get<Assignment[]>("rm", "/api/assignments")).body[0].cif_id;
    const same = await post<{ unchanged: number }>("loanops", "/api/assignments", { cif_ids: [mine, mine], rm_id: DEMO_RM });
    expect(same.body.unchanged).toBe(1);
    const moved = await post<{ moved: number; assigned: number }>("loanops", "/api/assignments", { cif_ids: [mine], rm_id: "RM002" });
    expect(moved.body.moved).toBe(1);
    expect(moved.body.assigned).toBe(0);
    expect((await get<Assignment[]>("rm", "/api/assignments")).body.some((a) => a.cif_id === mine)).toBe(false);
    expect((await get("rm", `/api/companies/${mine}/report`)).status).toBe(403);
    const rms = (await get<{ rm_id: string; assigned: number }[]>("loanops", "/api/rms")).body;
    expect(rms.find((r) => r.rm_id === "RM001")?.assigned).toBe(24);
  });

  it("writes the assignment to the audit log", async () => {
    await post("loanops", "/api/assignments", { cif_ids: ["C000001"], rm_id: "RM003" });
    const log = (await get<AuditEntry[]>("admin", "/api/admin/audit?limit=5")).body;
    expect(log.some((e) => e.action === "ASSIGN_RM" && e.target === "RM003")).toBe(true);
  });
});

describe("a few calls without a token still reach no data", () => {
  it("returns 401 for every protected path", async () => {
    for (const path of ["/api/overview", "/api/decisions", "/api/top50", "/api/offers", "/api/loan-status", "/api/companies"]) {
      const r = await call(null, "GET", path);
      expect(r.status, path).toBe(401);
    }
  });
});
