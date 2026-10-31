// Exasol's own evidence: the SQL audit log, one RUN_ANALYSIS step by step, EXPLAIN VIRTUAL and the
// Exasol Scheduler (backend/app/routes/exasol_audit.py).
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export interface AuditedStatement {
  session_id: string;
  stmt_id: number;
  started_at: string | null;
  exa_user: string;
  client: string | null;
  app_user: string;
  feature: string;
  consumer_group: string | null;
  command: string | null;
  sql: string | null;
  duration_s: number | null;
  cpu_pct: number | null;
  temp_ram_mib: number | null;
  rows: number | null;
  success: boolean;
  error: string | null;
  step_no?: number;
}

export interface AuditFilters {
  exa_user?: string;
  app_user?: string;
  feature?: string;
  success?: "" | "true" | "false";
  hours?: number;
}

export interface AnalysisTrace {
  run_id: string | null;
  call: AuditedStatement | null;
  statements: AuditedStatement[];
  commits: number;
}

export interface ScheduledTask {
  task_id: string;
  enabled: boolean;
  schedule: string | null;
  sql: string;
  after: string | null;
  is_final: boolean;
  comment: string | null;
  last_status: string | null;
  last_started_at: string | null;
}

export interface TaskRun {
  task_id: string;
  graph_run_id: string | null;
  phase: string;
  status: string;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  seconds: number | null;
  error: string | null;
}

export interface Schedule {
  installed: boolean;
  tasks: ScheduledTask[];
  runs: TaskRun[];
  purge: {
    next_due: string | null;
    rows_waiting: number | null;
    purge_log_entries: number;
    rows_deleted: number | null;
    last_purged_at: string | null;
  };
}

export interface Pushdown {
  key: string;
  source: string;
  schema: string;
  step: number;
  title: string;
  query: string;
  explain_ms: number;
  pushdowns: { id: number; tables: string | null; pushdown_sql: string; connection: string | null; driver: string | null; sql: string | null }[];
}

function qs(params: Record<string, string | number | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
}

export const useExasolAudit = (f: AuditFilters) =>
  useQuery({
    queryKey: ["exasol-audit", f],
    queryFn: () => api<{ items: AuditedStatement[]; read_as: string; hours: number }>(`/admin/exasol-audit${qs({ ...f })}`),
  });

export const useAnalysisTrace = () =>
  useQuery({ queryKey: ["exasol-audit-analysis"], queryFn: () => api<AnalysisTrace>("/admin/exasol-audit/analysis") });

export const useSchedule = () =>
  useQuery({ queryKey: ["exasol-schedule"], queryFn: () => api<Schedule>("/admin/schedule"), refetchInterval: 60_000 });

export const usePushdown = () =>
  useQuery({ queryKey: ["pushdown"], queryFn: async () => (await api<{ items: Pushdown[] }>("/sources/pushdown")).items, staleTime: 300_000 });
