import type { SourceId, SourceKind } from "../api/types";

export interface SourceMeta {
  id: SourceId;
  kind: SourceKind;
  /** Owner: who the data belongs to */
  owner: string;
  /** System: the system it was read from */
  system: string;
  /** Short system name for compact tags */
  short?: string;
  /** What the system holds */
  holds: string;
  /** Full label as specified in docs/API.md */
  label: string;
}

export const SOURCES: Record<SourceId, SourceMeta> = {
  "bank.oracle": {
    id: "bank.oracle",
    kind: "bank",
    owner: "Sapphire Bank",
    system: "Oracle",
    holds: "Core banking",
    label: "Sapphire Bank · Oracle (core banking)",
  },
  "bank.mysql": {
    id: "bank.mysql",
    kind: "bank",
    owner: "Sapphire Bank",
    system: "MySQL",
    holds: "Customer master",
    label: "Sapphire Bank · MySQL (customer master)",
  },
  "bank.postgres": {
    id: "bank.postgres",
    kind: "bank",
    owner: "Sapphire Bank",
    system: "PostgreSQL",
    holds: "Loans and CRM",
    label: "Sapphire Bank · PostgreSQL (loans and CRM)",
  },
  "api.cibil": {
    id: "api.cibil",
    kind: "api",
    owner: "API",
    system: "CIBIL",
    holds: "Credit bureau (mock)",
    label: "API · CIBIL (mock)",
  },
  "api.gstn": {
    id: "api.gstn",
    kind: "api",
    owner: "API",
    system: "GSTN",
    holds: "GST network (mock)",
    label: "API · GSTN (mock)",
  },
  "api.aa": {
    id: "api.aa",
    kind: "api",
    owner: "API",
    system: "Account Aggregator",
    short: "AA",
    holds: "Other-bank accounts (mock)",
    label: "API · Account Aggregator (mock)",
  },
  exasol: {
    id: "exasol",
    kind: "exasol",
    owner: "Exasol",
    system: "result",
    holds: "Computed by Exasol",
    label: "Exasol result",
  },
};

export const SOURCE_ORDER: SourceId[] = [
  "bank.oracle",
  "bank.mysql",
  "bank.postgres",
  "api.cibil",
  "api.gstn",
  "api.aa",
  "exasol",
];

export const KIND_LABEL: Record<SourceKind, string> = {
  bank: "Sapphire Bank data",
  api: "3rd party API (mock)",
  exasol: "Computed in Exasol",
};

export function sourceMeta(id: string | null | undefined): SourceMeta | null {
  if (!id) return null;
  return (SOURCES as Record<string, SourceMeta>)[id] ?? null;
}
