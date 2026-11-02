import type { Role } from "../api/types";

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  datasci: "Data scientist",
  loanops: "Loan operations",
  rm: "Relationship manager",
};

/** Permissions mirror the Roles column of docs/API.md. The backend enforces them; the UI only hides what a role cannot use. */
export const CAN = {
  generate: ["admin"],
  sources: ["admin", "datasci"],
  audit: ["admin"],
  /** Analysis runs page; loan operations sees published runs only. */
  runs: ["admin", "datasci", "loanops"],
  runAnalysis: ["datasci"],
  /** Hand a finished run to loan operations; until then it is a draft. */
  publish: ["datasci"],
  /** See draft (unpublished) runs. */
  drafts: ["admin", "datasci"],
  decisions: ["admin", "datasci", "loanops"],
  top50: ["admin", "datasci", "loanops"],
  report: ["admin", "datasci", "loanops", "rm"],
  models: ["admin", "datasci"],
  train: ["datasci"],
  /** Compute calibration and PSI evidence in Exasol (CALIBRATE_MODEL, MODEL_PSI). */
  computeValidation: ["admin", "datasci"],
  requestActivation: ["datasci"],
  whatif: ["datasci"],
  proposePolicy: ["datasci"],
  /** Approvals screen: policy proposals and model activations. */
  approvePolicy: ["admin"],
  approveModels: ["admin"],
  /** Assign companies to relationship managers (single, bulk, reassign). */
  assign: ["loanops"],
  /** Loan status tracker over every assigned company. */
  loanStatus: ["admin", "datasci", "loanops"],
  /** The relationship manager's own book: assigned companies and their loan status. */
  myBook: ["rm"],
  logStatus: ["rm"],
  offers: ["rm", "loanops", "admin"],
  negotiate: ["rm"],
  checker: ["loanops"],
  ask: ["admin", "datasci", "loanops", "rm"],
  memo: ["admin", "datasci", "loanops", "rm"],
} satisfies Record<string, Role[]>;

export type Permission = keyof typeof CAN;

export function can(role: Role | undefined, p: Permission): boolean {
  return !!role && (CAN[p] as Role[]).includes(role);
}
