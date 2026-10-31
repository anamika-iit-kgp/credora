// Explain mode: the Exasol console and the Exasol control room (docs/API.md, "Explain mode").
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export interface ConsoleEntry {
  id: number;
  /** Changes when a repeated statement (a poll) is counted again. */
  seq: number;
  at: string;
  kind: "sql" | "step" | "mcp" | "event";
  exa_user: string | null;
  username: string | null;
  role: string | null;
  session: string | null;
  label: string | null;
  sql: string | null;
  text: string | null;
  ms: number | null;
  rows: number | null;
  error: string | null;
  repeat: number;
  via: string | null;
  tool: string | null;
  objects: string[];
}

export interface ConsolePage {
  entries: ConsoleEntry[];
  last: number;
  scope: "session" | "user" | "all";
  exasol_user: string | null;
}

export type ConsoleScope = ConsolePage["scope"];

export function fetchConsole(since: number, scope: ConsoleScope, signal?: AbortSignal) {
  return api<ConsolePage>(`/exasol/console?since=${since}&scope=${scope}`, { signal });
}

/** One part of the control room: data, or Exasol's refusal (which is itself the point for some roles). */
export type Section<T> = { ok: true; data: T; ms: number } | { ok: false; denied: boolean; error: string; ms: number };

export interface CrSystem {
  version: string | null;
  current_user: string;
  session_id: string;
  instance_type: string | null;
  deployment: string;
  nodes?: number;
  vcpu?: number;
  db_ram_gib?: number;
}
export interface CrSchema {
  name: string;
  owner: string;
  virtual: boolean;
  comment: string | null;
  counts: Record<string, number>;
  visible: number;
}
export interface CrVirtualSchema {
  name: string;
  adapter: string;
  last_refresh: string | null;
  last_refresh_by: string | null;
  driver?: string | null;
  driver_version?: string | null;
  source?: string;
  database?: string;
  holds?: string;
  connection?: string;
  extension?: string;
}
export interface CrScript {
  schema: string;
  name: string;
  type: string;
  language: string;
  input: string | null;
  result: string | null;
  comment: string | null;
}
export interface CrModel {
  version: string;
  algorithm: string;
  trained_at: string | null;
  auc: number | null;
  gini: number | null;
  train_rows: number | null;
  path: string | null;
  active: boolean;
}
export interface CrRole {
  role: string;
  users: string[];
  system: string[];
  objects: { privilege: string; type: string; object: string }[];
}
export interface CrMetric {
  name: string;
  display: string | null;
  description: string | null;
  expression: string | null;
  filter: string | null;
  kind: string | null;
  certified: boolean;
}
export interface CrSession {
  session_id: string;
  user: string;
  status: string;
  command: string;
  duration: string;
  login_time: string | null;
  client: string | null;
  driver: string | null;
  consumer_group: string | null;
}

export interface ControlRoom {
  role: string;
  exasol_user: string;
  read_at: string;
  took_ms: number;
  cached: boolean;
  system: Section<CrSystem>;
  schemas: Section<CrSchema[]>;
  virtual_schemas: Section<CrVirtualSchema[]>;
  scripts: Section<{ items: CrScript[]; per_schema: Record<string, number>; total: number }>;
  connections: Section<{ name: string; created: string | null }[]>;
  models: Section<CrModel[]>;
  security: Section<{ scope: "dba" | "own"; roles: CrRole[]; users: string[] }>;
  preprocessor: Section<{ system: string | null; session: string | null; languages: { alias: string; builtin: boolean; container: string }[] }>;
  semantic: Section<{
    version: string | null;
    models: { name: string; schema: string; status: string; surface: string; model_version: number; description: string | null }[];
    metrics: CrMetric[];
  }>;
  run_log: Section<{ run_id: string | null; steps: { n: number; name: string; status: string; rows: number | null; ms: number | null; at: string | null }[] }>;
  sessions: Section<CrSession[]> | null;
}

export const useControlRoom = () =>
  useQuery({
    queryKey: ["exasol", "control-room"],
    queryFn: () => api<ControlRoom>("/exasol/control-room"),
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
