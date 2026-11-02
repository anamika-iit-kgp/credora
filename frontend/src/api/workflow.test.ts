import { describe, expect, it } from "vitest";
import type { LoanStatus } from "./types";
import { LOAN_STATUS_LABEL, NEEDS_AGREED_OFFER, NEXT_STATUS, RM_STATUSES } from "./workflow";

const ALL: LoanStatus[] = ["ASSIGNED", "CONTACTED", "NEGOTIATING", "LOAN_TAKEN", "IN_PROGRESS", "DISBURSED", "NOT_INTERESTED"];
const FORWARD: LoanStatus[] = ["ASSIGNED", "CONTACTED", "NEGOTIATING", "LOAN_TAKEN", "IN_PROGRESS", "DISBURSED"];

/** Every status reachable from `from` in any number of steps. */
function reachable(from: LoanStatus): Set<LoanStatus> {
  const seen = new Set<LoanStatus>();
  const todo: LoanStatus[] = [from];
  while (todo.length) {
    const s = todo.pop() as LoanStatus;
    for (const n of NEXT_STATUS[s]) {
      if (!seen.has(n)) {
        seen.add(n);
        todo.push(n);
      }
    }
  }
  return seen;
}

describe("loan status state machine", () => {
  it("knows each of the seven statuses once, in the table and in the labels", () => {
    expect(Object.keys(NEXT_STATUS).sort()).toEqual([...ALL].sort());
    expect(Object.keys(LOAN_STATUS_LABEL).sort()).toEqual([...ALL].sort());
  });

  it("labels each status with its own readable name", () => {
    const labels = Object.values(LOAN_STATUS_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(l).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    expect(LOAN_STATUS_LABEL.LOAN_TAKEN).toBe("Loan taken");
    expect(LOAN_STATUS_LABEL.NOT_INTERESTED).toBe("Not interested");
  });

  it("moves a loan forward one step at a time", () => {
    for (let i = 0; i < FORWARD.length - 1; i++) expect(NEXT_STATUS[FORWARD[i]]).toContain(FORWARD[i + 1]);
  });

  it("does not let a loan skip a step", () => {
    for (let i = 0; i < FORWARD.length; i++) {
      for (let j = i + 2; j < FORWARD.length; j++) expect(NEXT_STATUS[FORWARD[i]], `${FORWARD[i]} to ${FORWARD[j]}`).not.toContain(FORWARD[j]);
    }
  });

  it("does not let a loan go back a step", () => {
    for (let i = 1; i < FORWARD.length; i++) {
      for (let j = 0; j < i; j++) expect(NEXT_STATUS[FORWARD[i]], `${FORWARD[i]} to ${FORWARD[j]}`).not.toContain(FORWARD[j]);
    }
  });

  it("never moves a status to itself", () => {
    for (const s of ALL) expect(NEXT_STATUS[s]).not.toContain(s);
  });

  it("never moves back to Assigned, which only loan operations sets", () => {
    for (const s of ALL) expect(NEXT_STATUS[s]).not.toContain("ASSIGNED");
  });

  it("makes Disbursed final", () => {
    expect(NEXT_STATUS.DISBURSED).toEqual([]);
    const terminal = ALL.filter((s) => NEXT_STATUS[s].length === 0);
    expect(terminal).toEqual(["DISBURSED"]);
  });

  it("lets the customer drop out from every status before Disbursed", () => {
    for (const s of ALL) {
      if (s === "DISBURSED" || s === "NOT_INTERESTED") continue;
      expect(NEXT_STATUS[s], s).toContain("NOT_INTERESTED");
    }
  });

  it("lets a lost customer be contacted again and nothing else", () => {
    expect(NEXT_STATUS.NOT_INTERESTED).toEqual(["CONTACTED"]);
  });

  it("reaches every other status from Assigned, and Disbursed only through In progress", () => {
    expect([...reachable("ASSIGNED")].sort()).toEqual(ALL.filter((s) => s !== "ASSIGNED").sort());
    const into = ALL.filter((s) => NEXT_STATUS[s].includes("DISBURSED"));
    expect(into).toEqual(["IN_PROGRESS"]);
  });

  it("has no dead ends before Disbursed", () => {
    for (const s of ALL) if (s !== "DISBURSED") expect(reachable(s).has("DISBURSED"), s).toBe(true);
  });

  it("lists every target once per status", () => {
    for (const s of ALL) expect(new Set(NEXT_STATUS[s]).size).toBe(NEXT_STATUS[s].length);
  });
});

describe("what a relationship manager can log", () => {
  it("is every status except Assigned", () => {
    expect([...RM_STATUSES].sort()).toEqual(ALL.filter((s) => s !== "ASSIGNED").sort());
  });

  it("covers every target of the state machine", () => {
    for (const s of ALL) for (const n of NEXT_STATUS[s]) expect(RM_STATUSES).toContain(n);
  });

  it("lists the statuses in the order a loan moves", () => {
    expect(RM_STATUSES).toEqual(["CONTACTED", "NEGOTIATING", "LOAN_TAKEN", "IN_PROGRESS", "DISBURSED", "NOT_INTERESTED"]);
  });
});

describe("statuses that need an agreed offer", () => {
  it("start at Loan taken and run to the end of the loan", () => {
    expect(NEEDS_AGREED_OFFER).toEqual(["LOAN_TAKEN", "IN_PROGRESS", "DISBURSED"]);
  });

  it("leave the early talks and the exit open", () => {
    for (const s of ["ASSIGNED", "CONTACTED", "NEGOTIATING", "NOT_INTERESTED"] as const) expect(NEEDS_AGREED_OFFER).not.toContain(s);
  });

  it("are all statuses a relationship manager can log", () => {
    for (const s of NEEDS_AGREED_OFFER) expect(RM_STATUSES).toContain(s);
  });

  it("sit on the forward path after every status that does not need an offer", () => {
    const first = FORWARD.findIndex((s) => NEEDS_AGREED_OFFER.includes(s));
    FORWARD.forEach((s, i) => expect(NEEDS_AGREED_OFFER.includes(s)).toBe(i >= first));
  });
});
