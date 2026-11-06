// The loan status state machine as the fixture server enforces it (POST /api/loan-status/{cif}), checked against
// the table the UI uses (api/workflow.ts). The fixture server mirrors backend app/rmbook.py.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry, LoanStatus, LoanStatusEvent, LoanStatusRow, Offer } from "../api/types";
import { LOAN_STATUS_LABEL, NEEDS_AGREED_OFFER, NEXT_STATUS, RM_STATUSES } from "../api/workflow";
import { bootFixtures, detail, freshFixtures, get, post } from "../test/fixtureApi";

beforeAll(() => {
  bootFixtures();
});
beforeEach(() => {
  freshFixtures();
});

const book = async () => (await get<LoanStatusRow[]>("rm", "/api/loan-status")).body;
const rowOf = async (cif: string) => (await book()).find((r) => r.cif_id === cif) as LoanStatusRow;
const log = (cif: string, status: string, note = "Called the customer.") => post<LoanStatusEvent>("rm", `/api/loan-status/${cif}`, { status, note });

/** A company in the RM's book that is still at Assigned and whose offer is in the given stage. */
async function assignedWith(stage: string): Promise<LoanStatusRow> {
  const rows = (await book()).filter((r) => r.status === "ASSIGNED" && r.offer_stage === stage).sort((a, b) => (a.rank_no ?? 9999) - (b.rank_no ?? 9999));
  expect(rows.length, `a book company at Assigned with a ${stage} offer`).toBeGreaterThan(0);
  return rows[0];
}

describe("the tracker rows", () => {
  it("only offer next statuses that the state machine allows", async () => {
    const rows = (await get<LoanStatusRow[]>("loanops", "/api/loan-status")).body;
    expect(rows.length).toBeGreaterThan(30);
    for (const r of rows) {
      expect(Object.keys(LOAN_STATUS_LABEL)).toContain(r.status);
      const expected = NEXT_STATUS[r.status].filter((s) => !(r.offer_block && NEEDS_AGREED_OFFER.includes(s)));
      expect(r.next_statuses, `${r.cif_id} at ${r.status}`).toEqual(expected);
    }
  });

  it("offer nothing after Disbursed and show no block there", async () => {
    const done = (await get<LoanStatusRow[]>("loanops", "/api/loan-status")).body.filter((r) => r.status === "DISBURSED");
    expect(done.length).toBeGreaterThan(0);
    for (const r of done) {
      expect(r.next_statuses).toEqual([]);
      expect(r.offer_block).toBeNull();
    }
  });

  it("keep the history newest first, ending with the assignment", async () => {
    for (const r of (await get<LoanStatusRow[]>("loanops", "/api/loan-status")).body) {
      expect(r.history.length).toBeGreaterThan(0);
      expect(r.history[0].status).toBe(r.status);
      expect(r.history[r.history.length - 1].status).toBe("ASSIGNED");
      for (let i = 1; i < r.history.length; i++) expect(r.history[i - 1].at >= r.history[i].at).toBe(true);
    }
  });
});

describe("who may log a status", () => {
  it("is the relationship manager, and only for a company in the book", async () => {
    const mine = (await book())[0].cif_id;
    for (const role of ["admin", "datasci", "loanops"] as const) expect((await post(role, `/api/loan-status/${mine}`, { status: "CONTACTED", note: "x" })).status).toBe(403);
    const all = (await get<LoanStatusRow[]>("loanops", "/api/loan-status")).body;
    const other = all.find((r) => r.rm_id !== "RM001") as LoanStatusRow;
    const r = await log(other.cif_id, "CONTACTED");
    expect(r.status).toBe(403);
    expect(detail(r)).toBe(`${other.cif_id} is not assigned to you.`);
  });

  it("refuses a company that is in nobody's book", async () => {
    expect((await log("C000001", "CONTACTED")).status).toBe(403);
  });
});

describe("the status and the note", () => {
  it("accepts only the statuses a relationship manager can log", async () => {
    const cif = (await assignedWith("OFFERED")).cif_id;
    for (const bad of ["ASSIGNED", "BOGUS", "", "disbursed now"]) {
      const r = await log(cif, bad);
      expect(r.status, bad).toBe(422);
      expect(detail(r)).toBe(`status must be one of ${RM_STATUSES.join(", ")}`);
    }
  });

  it("reads the status in any letter case", async () => {
    const cif = (await assignedWith("OFFERED")).cif_id;
    const r = await log(cif, "contacted");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("CONTACTED");
  });

  it("requires a note and refuses a missing, empty or blank one", async () => {
    const row = await assignedWith("OFFERED");
    for (const note of [undefined, "", "   ", "\n\t"]) {
      const r = await post("rm", `/api/loan-status/${row.cif_id}`, note === undefined ? { status: "CONTACTED" } : { status: "CONTACTED", note });
      expect(r.status, JSON.stringify(note)).toBe(422);
      expect(detail(r)).toBe("A note is required.");
    }
    const after = await rowOf(row.cif_id);
    expect(after.status).toBe("ASSIGNED");
    expect(after.history).toHaveLength(row.history.length);
  });

  it("trims the note it keeps", async () => {
    const cif = (await assignedWith("OFFERED")).cif_id;
    const r = await log(cif, "CONTACTED", "   Spoke to the CFO.  ");
    expect(r.body.note).toBe("Spoke to the CFO.");
  });

  it("records who logged it, for which manager and when", async () => {
    const cif = (await assignedWith("OFFERED")).cif_id;
    const r = await log(cif, "CONTACTED");
    expect(r.body).toMatchObject({ cif_id: cif, rm_id: "RM001", status: "CONTACTED", actor: "rm" });
    expect(Number.isNaN(Date.parse(r.body.at))).toBe(false);
    const row = await rowOf(cif);
    expect(row.status).toBe("CONTACTED");
    expect(row.updated_by).toBe("rm");
    expect(row.note).toBe("Called the customer.");
    expect(row.history[0].event_id).toBe(r.body.event_id);
  });

  it("writes the change to the audit log", async () => {
    const cif = (await assignedWith("OFFERED")).cif_id;
    await log(cif, "CONTACTED", "Called.");
    const audit = (await get<AuditEntry[]>("admin", "/api/admin/audit?limit=10")).body;
    expect(audit.some((e) => e.action === "LOAN_STATUS" && e.target === cif && e.detail === "CONTACTED: Called.")).toBe(true);
  });

  it("shows loan operations the change at once", async () => {
    const cif = (await assignedWith("OFFERED")).cif_id;
    await log(cif, "CONTACTED");
    const seen = (await get<LoanStatusRow[]>("loanops", "/api/loan-status")).body.find((r) => r.cif_id === cif);
    expect(seen?.status).toBe("CONTACTED");
  });
});

describe("allowed transitions", () => {
  it("refuses every logged status that the state machine does not list for Assigned", async () => {
    const cif = (await assignedWith("OFFERED")).cif_id;
    for (const target of RM_STATUSES.filter((s) => !NEXT_STATUS.ASSIGNED.includes(s))) {
      const r = await log(cif, target);
      expect(r.status, target).toBe(409);
      expect(detail(r)).toBe(`ASSIGNED can move only to ${NEXT_STATUS.ASSIGNED.join(" or ")}.`);
    }
    expect((await rowOf(cif)).status).toBe("ASSIGNED");
  });

  it("refuses the same status twice", async () => {
    const cif = (await assignedWith("OFFERED")).cif_id;
    expect((await log(cif, "CONTACTED")).status).toBe(200);
    const again = await log(cif, "CONTACTED");
    expect(again.status).toBe(409);
    expect(detail(again)).toBe("The status is already that.");
  });

  it("lets a customer drop out at any step and be contacted again, and nothing else", async () => {
    const cif = (await assignedWith("OFFERED")).cif_id;
    expect((await log(cif, "NOT_INTERESTED")).status).toBe(200);
    for (const target of RM_STATUSES.filter((s) => s !== "NOT_INTERESTED" && s !== "CONTACTED")) {
      const r = await log(cif, target);
      expect(r.status, target).toBe(409);
      expect(detail(r)).toBe("NOT_INTERESTED can move only to CONTACTED.");
    }
    expect((await log(cif, "CONTACTED")).status).toBe(200);
    expect((await rowOf(cif)).status).toBe("CONTACTED");
  });

  it("offers on the row exactly what the server then accepts", async () => {
    const cif = (await assignedWith("OFFERED")).cif_id;
    for (const step of ["CONTACTED", "NEGOTIATING"] as const) {
      const row = await rowOf(cif);
      expect(row.next_statuses).toContain(step);
      for (const s of row.next_statuses ?? []) expect(NEXT_STATUS[row.status]).toContain(s);
      expect((await log(cif, step)).status).toBe(200);
    }
  });
});

describe("a loan that is sanctioned goes all the way to Disbursed", () => {
  it("walks the forward path, then refuses every change", async () => {
    const cif = (await assignedWith("SANCTIONED")).cif_id;
    const path: LoanStatus[] = ["CONTACTED", "NEGOTIATING", "LOAN_TAKEN", "IN_PROGRESS", "DISBURSED"];
    for (const step of path) {
      const r = await log(cif, step, `Moved to ${LOAN_STATUS_LABEL[step]}.`);
      expect(r.status, step).toBe(200);
      const row = await rowOf(cif);
      expect(row.status).toBe(step);
      expect(row.next_statuses).toEqual(NEXT_STATUS[step]);
      expect(row.offer_block).toBeNull();
    }
    const row = await rowOf(cif);
    expect(row.history.map((e) => e.status).reverse()).toEqual(["ASSIGNED", ...path]);
    expect(row.next_statuses).toEqual([]);
    for (const target of RM_STATUSES) {
      const r = await log(cif, target);
      expect(r.status, target).toBe(409);
      expect(detail(r)).toBe("The loan is disbursed, so its status no longer changes.");
    }
    expect((await rowOf(cif)).history).toHaveLength(row.history.length);
  });
});

describe("statuses that need an agreed offer", () => {
  it("blocks Loan taken while no terms are agreed, and offers nothing from Loan taken on", async () => {
    const row = await assignedWith("OFFERED");
    expect(row.offer_block).toContain("No terms are agreed yet");
    expect(row.next_statuses).toEqual(NEXT_STATUS.ASSIGNED);
    await log(row.cif_id, "CONTACTED");
    await log(row.cif_id, "NEGOTIATING");
    const talking = await rowOf(row.cif_id);
    expect(talking.next_statuses).toEqual(["NOT_INTERESTED"]);
    const r = await log(row.cif_id, "LOAN_TAKEN");
    expect(r.status).toBe(409);
    expect(detail(r)).toBe(`LOAN_TAKEN needs agreed terms. ${row.offer_block}`);
    expect((await rowOf(row.cif_id)).status).toBe("NEGOTIATING");
  });

  it("opens Loan taken once the manager has agreed terms inside the limit", async () => {
    const row = await assignedWith("OFFERED");
    await log(row.cif_id, "CONTACTED");
    await log(row.cif_id, "NEGOTIATING");
    const offer = (await get<Offer[]>("rm", "/api/offers")).body.find((o) => o.cif_id === row.cif_id) as Offer;
    const terms = { amount: offer.offer_amount, roi: offer.offer_roi, tenure: offer.offer_tenure, note: "Customer agreed to the offer." };
    const quote = await post<{ within_limit: boolean }>("rm", `/api/offers/${offer.offer_id}/quote`, terms);
    expect(quote.body.within_limit).toBe(true);
    const proposed = await post<Offer>("rm", `/api/offers/${offer.offer_id}/propose`, terms);
    expect(proposed.body.stage).toBe("NEGOTIATING");
    const open = await rowOf(row.cif_id);
    expect(open.offer_block).toBeNull();
    expect(open.next_statuses).toEqual(NEXT_STATUS.NEGOTIATING);
    expect((await log(row.cif_id, "LOAN_TAKEN")).status).toBe(200);
  });

  it("keeps Loan taken shut on terms above the limit until loan operations verifies and the admin sanctions them", async () => {
    const row = await assignedWith("ESCALATED");
    expect(row.offer_block).toContain("above the negotiation limits");
    await log(row.cif_id, "CONTACTED");
    await log(row.cif_id, "NEGOTIATING");
    const blocked = await log(row.cif_id, "LOAN_TAKEN");
    expect(blocked.status).toBe(409);
    expect(detail(blocked)).toContain("above the negotiation limits");

    const id = row.offer_id as number;
    const noNote = await post("loanops", `/api/offers/${id}/verify`, { note: " " });
    expect(noNote.status).toBe(422);
    expect(detail(noNote)).toBe("A note is required.");
    expect((await post("admin", `/api/offers/${id}/sanction`, { note: "Too early." })).status).toBe(409);
    expect((await post("loanops", `/api/offers/${id}/verify`, { note: "Checked the figures." })).status).toBe(200);
    expect((await log(row.cif_id, "LOAN_TAKEN")).status).toBe(409);
    expect((await post("loanops", `/api/offers/${id}/sanction`, { note: "Not my step." })).status).toBe(403);
    expect((await post("admin", `/api/offers/${id}/sanction`, { note: "Sanctioned." })).status).toBe(200);
    expect((await log(row.cif_id, "LOAN_TAKEN")).status).toBe(200);
  });

  it("leaves Contacted, Negotiating and Not interested open without any offer terms", async () => {
    const row = await assignedWith("OFFERED");
    for (const s of ["CONTACTED", "NEGOTIATING", "NOT_INTERESTED"] as const) {
      expect(NEEDS_AGREED_OFFER).not.toContain(s);
      expect((await log(row.cif_id, s)).status, s).toBe(200);
    }
  });
});
