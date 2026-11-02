import { describe, expect, it } from "vitest";
import type { Role } from "../api/types";
import { CAN, can, type Permission, ROLE_LABEL } from "./roles";

const ROLES: Role[] = ["admin", "datasci", "loanops", "rm"];
const PERMISSIONS = Object.keys(CAN) as Permission[];

const heldBy = (role: Role) => PERMISSIONS.filter((p) => can(role, p)).sort();
const rolesWith = (p: Permission) => ROLES.filter((r) => can(r, p));

describe("role labels", () => {
  it("name each of the four roles", () => {
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...ROLES].sort());
    expect(ROLE_LABEL).toEqual({
      admin: "Admin",
      datasci: "Data scientist",
      loanops: "Loan operations",
      rm: "Relationship manager",
    });
  });
});

describe("can", () => {
  it("says no when nobody is signed in", () => {
    for (const p of PERMISSIONS) expect(can(undefined, p), p).toBe(false);
  });

  it("says yes exactly for the roles listed in the table", () => {
    for (const p of PERMISSIONS) for (const r of ROLES) expect(can(r, p), `${r} ${p}`).toBe((CAN[p] as Role[]).includes(r));
  });

  it("says no for a role the table does not know", () => {
    expect(can("auditor" as Role, "report")).toBe(false);
    expect(can("" as Role, "report")).toBe(false);
  });

  it("only lists the four known roles in the table", () => {
    for (const p of PERMISSIONS) for (const r of CAN[p] as string[]) expect(ROLES).toContain(r);
  });

  it("lists every role once per permission", () => {
    for (const p of PERMISSIONS) expect(new Set(CAN[p]).size).toBe(CAN[p].length);
  });

  it("leaves no permission without a role and no role without a permission", () => {
    for (const p of PERMISSIONS) expect(rolesWith(p).length, p).toBeGreaterThan(0);
    for (const r of ROLES) expect(heldBy(r).length, r).toBeGreaterThan(0);
  });
});

describe("what each role may open or do", () => {
  it("lets the admin generate data, read the audit and approve, but not run or train", () => {
    expect(heldBy("admin")).toEqual(
      ["approveModels", "approvePolicy", "ask", "audit", "computeValidation", "decisions", "drafts", "generate", "loanStatus", "memo", "models", "offers", "report", "runs", "sources", "top50"].sort(),
    );
  });

  it("lets the data scientist run, train, publish, request and propose, but not approve or assign", () => {
    expect(heldBy("datasci")).toEqual(
      ["ask", "computeValidation", "decisions", "drafts", "loanStatus", "memo", "models", "proposePolicy", "publish", "report", "requestActivation", "runAnalysis", "runs", "sources", "top50", "train", "whatif"].sort(),
    );
  });

  it("lets loan operations assign and check offers, but not see drafts or models", () => {
    expect(heldBy("loanops")).toEqual(["ask", "assign", "checker", "decisions", "loanStatus", "memo", "offers", "report", "runs", "top50"].sort());
  });

  it("lets the relationship manager work only her own book and her offers", () => {
    expect(heldBy("rm")).toEqual(["ask", "logStatus", "memo", "myBook", "negotiate", "offers", "report"].sort());
  });

  it("keeps the relationship manager out of the bank-wide pages", () => {
    for (const p of ["decisions", "top50", "runs", "models", "sources", "audit", "loanStatus", "generate"] as const) expect(can("rm", p), p).toBe(false);
  });

  it("gives every role the report, the memo and Ask Credora", () => {
    for (const p of ["report", "memo", "ask"] as const) expect(rolesWith(p)).toEqual(ROLES);
  });

  it("shows drafts to the people who make runs and keeps them from loan operations and relationship managers", () => {
    expect(rolesWith("drafts")).toEqual(["admin", "datasci"]);
    expect(rolesWith("runs")).toEqual(["admin", "datasci", "loanops"]);
  });

  it("gives each action to exactly one role when it changes the data", () => {
    const single: [Permission, Role][] = [
      ["generate", "admin"],
      ["runAnalysis", "datasci"],
      ["publish", "datasci"],
      ["train", "datasci"],
      ["assign", "loanops"],
      ["logStatus", "rm"],
      ["negotiate", "rm"],
      ["checker", "loanops"],
    ];
    for (const [p, r] of single) expect(rolesWith(p), p).toEqual([r]);
  });
});

describe("maker and checker", () => {
  it("never lets the same role request a model switch and approve it", () => {
    for (const r of ROLES) expect(can(r, "requestActivation") && can(r, "approveModels"), r).toBe(false);
    expect(rolesWith("requestActivation")).toEqual(["datasci"]);
    expect(rolesWith("approveModels")).toEqual(["admin"]);
  });

  it("never lets the same role propose a policy change and approve it", () => {
    for (const r of ROLES) expect(can(r, "proposePolicy") && can(r, "approvePolicy"), r).toBe(false);
    expect(rolesWith("proposePolicy")).toEqual(["datasci"]);
    expect(rolesWith("approvePolicy")).toEqual(["admin"]);
  });

  it("never lets the same role negotiate an offer and check it", () => {
    for (const r of ROLES) expect(can(r, "negotiate") && can(r, "checker"), r).toBe(false);
    expect(rolesWith("negotiate")).toEqual(["rm"]);
    expect(rolesWith("checker")).toEqual(["loanops"]);
  });

  it("never lets the same role make a run and assign its companies", () => {
    for (const r of ROLES) expect(can(r, "runAnalysis") && can(r, "assign"), r).toBe(false);
  });

  it("never lets a role that approves also run the analysis", () => {
    for (const r of ROLES) expect(can(r, "approvePolicy") && can(r, "runAnalysis"), r).toBe(false);
  });
});
