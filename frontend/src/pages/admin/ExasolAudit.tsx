import { useState } from "react";
import { CalendarClock, Fingerprint, ListTree, ScrollText } from "lucide-react";
import { useAnalysisTrace, useExasolAudit, useSchedule, type AuditFilters, type AuditedStatement } from "../../api/exasolAudit";
import { Empty, ErrorState, Loading, PageHeader, Panel, Segmented } from "../../components/ui";
import { dateTime, num } from "../../lib/format";
import "../../styles/exasol-audit.css";

const EXA_USERS = [
  "CREDORA_SVC", "CREDORA_ADMIN", "CREDORA_DATASCI", "CREDORA_LOANOPS", "CREDORA_RM", "CREDORA_RM002",
  "CREDORA_ADMIN_AI", "CREDORA_DATASCI_AI", "CREDORA_LOANOPS_AI", "CREDORA_RM_AI", "CREDORA_MCP",
];
const APP_USERS = ["admin", "datasci", "loanops", "rm", "system", "scheduler"];

/** SQL as audited, without the credora tag comment (shown in its own column). */
function bareSql(sql: string | null, max = 220): string {
  const s = (sql ?? "").replace(/^\s*\/\*credora:[^*]*\*\/\s*/, "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function cronText(schedule: string | null, after: string | null, isFinal: boolean): string {
  if (!schedule) return after ? `${isFinal ? "Finalizer after" : "After"} ${after}` : "";
  const m = schedule.match(/^CRON (\S+) (\S+) (\S+) (\S+) (\S+) (\S+)(?: TZ=(\S+))?/);
  if (!m) return schedule;
  const [, , min, hour, , , , tz] = m;
  const zone = tz === "Asia/Kolkata" ? "IST" : tz ?? "";
  if (min.startsWith("*/") && hour === "*") return `Every ${min.slice(2)} minutes`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) return `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")} ${zone}`;
  return schedule;
}

function Status({ ok, label }: { ok: boolean | null; label?: string }) {
  if (ok === null) return <span className="muted">not run yet</span>;
  return <span className={ok ? "text-approve" : "text-decline"}>{label ?? (ok ? "Succeeded" : "Failed")}</span>;
}

function ScheduleSection() {
  const q = useSchedule();
  return (
    <Panel
      title="Scheduled jobs in Exasol"
      icon={CalendarClock}
      aside={<span className="muted">exasol-labs/exasol-scheduler · SCHED.SCHED_TASKS and SCHED_HISTORY</span>}
      flush
    >
      {q.isLoading && <Loading rows={3} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && !q.data.installed && <Empty title="The scheduler's tables are not installed yet" icon={CalendarClock} />}
      {q.data && q.data.installed && (
        <>
          <p className="xa-note">
            The Exasol Scheduler runs these jobs as <code>CREDORA_SVC</code> in consumer group <code>CREDORA_BATCH</code>, from tasks kept in Exasol. Consent-based 3rd party data, fetched on demand via API, is
            deleted on time with SHA-256 proof, by the Exasol Scheduler.{" "}
            {q.data.purge.next_due && (
              <>
                Next rows due at <strong>{dateTime(q.data.purge.next_due)}</strong> ({num(q.data.purge.rows_waiting)} staged rows waiting).{" "}
              </>
            )}
            {q.data.purge.purge_log_entries > 0
              ? `PURGE_LOG holds ${num(q.data.purge.purge_log_entries)} proofs (${num(q.data.purge.rows_deleted)} rows deleted).`
              : "No staged row has reached its purge time yet, so PURGE_LOG is still empty."}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">When</th>
                  <th scope="col">SQL Exasol runs</th>
                  <th scope="col">Last run</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {q.data.tasks.map((t) => (
                  <tr key={t.task_id}>
                    <td>
                      <code>{t.task_id}</code>
                      {t.comment && <div className="muted xa-small">{t.comment}</div>}
                    </td>
                    <td className="nowrap">{cronText(t.schedule, t.after, t.is_final)}</td>
                    <td>
                      <code>{t.sql}</code>
                    </td>
                    <td className="nowrap muted">{t.last_started_at ? dateTime(t.last_started_at) : ""}</td>
                    <td>
                      <Status ok={t.last_status ? t.last_status === "SUCCEEDED" : null} label={t.last_status ?? undefined} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

function AnalysisSection() {
  const q = useAnalysisTrace();
  const steps = new Map<number, AuditedStatement[]>();
  for (const s of q.data?.statements ?? []) steps.set(s.step_no ?? 0, [...(steps.get(s.step_no ?? 0) ?? []), s]);
  return (
    <Panel title="One analysis, as Exasol audited it" icon={ListTree} flush>
      {q.isLoading && <Loading rows={4} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && !q.data.call && <Empty title="No RUN_ANALYSIS in the audit log yet" icon={ListTree} />}
      {q.data && q.data.call && (
        <>
          <p className="xa-note">
            <code>EXECUTE SCRIPT CREDORA.RUN_ANALYSIS('{q.data.run_id}')</code> ran as <code>{q.data.call.exa_user}</code> in consumer group{" "}
            <code>{q.data.call.consumer_group}</code>
            {q.data.call.app_user && (
              <>
                , started by <strong>{q.data.call.app_user}</strong>
              </>
            )}{" "}
            on {dateTime(q.data.call.started_at)}, {num(q.data.call.duration_s, 1)} s. Exasol recorded {num(q.data.statements.length)} statements
            inside it and <strong>{q.data.commits} COMMITs</strong>. Each step is committed as it finishes, so its RUN_LOG row is visible at once.
          </p>
          <div className="table-wrap table-wrap-tall">
            <table className="table xa-table">
              <thead>
                <tr>
                  <th scope="col" className="r">
                    Step
                  </th>
                  <th scope="col">Command</th>
                  <th scope="col">SQL</th>
                  <th scope="col" className="r">
                    Rows
                  </th>
                  <th scope="col" className="r">
                    Seconds
                  </th>
                  <th scope="col" className="r">
                    Temp RAM MiB
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...steps.entries()].flatMap(([step, list]) =>
                  list.map((s, i) => (
                    <tr key={s.stmt_id} className={`${i === 0 ? "row-group-start" : ""} ${s.command === "COMMIT" ? "xa-commit" : ""}`}>
                      <td className="r num">{i === 0 ? step : ""}</td>
                      <td className="nowrap">
                        <code>{s.command}</code>
                      </td>
                      <td className="xa-sql">
                        <code>{bareSql(s.sql, 160)}</code>
                      </td>
                      <td className="r num">{num(s.rows)}</td>
                      <td className="r num">{num(s.duration_s, 3)}</td>
                      <td className="r num muted">{num(s.temp_ram_mib, 1)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

function StatementsSection() {
  const [f, setF] = useState<AuditFilters>({ hours: 24, success: "" });
  const set = (k: keyof AuditFilters, v: string | number) => setF((o) => ({ ...o, [k]: v }));
  const q = useExasolAudit(f);
  return (
    <Panel title="Audited statements" icon={ScrollText} aside={<span className="muted">EXA_DBA_AUDIT_SQL + EXA_DBA_AUDIT_SESSIONS, read as CREDORA_ADMIN</span>} flush>
      <div className="filters">
        <label className="field field-inline">
          <span className="field-label">Exasol user</span>
          <select className="input" value={f.exa_user ?? ""} onChange={(e) => set("exa_user", e.target.value)}>
            <option value="">All Credora users</option>
            {EXA_USERS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
        <label className="field field-inline">
          <span className="field-label">App user</span>
          <select className="input" value={f.app_user ?? ""} onChange={(e) => set("app_user", e.target.value)}>
            <option value="">Anyone</option>
            {APP_USERS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
        <label className="field field-inline">
          <span className="field-label">Feature</span>
          <input className="input" placeholder="e.g. decisions" value={f.feature ?? ""} onChange={(e) => set("feature", e.target.value)} />
        </label>
        <Segmented
          label="Result"
          value={f.success ?? ""}
          onChange={(v) => set("success", v)}
          options={[
            { value: "", label: "All" },
            { value: "true", label: "Succeeded" },
            { value: "false", label: "Failed" },
          ]}
        />
        <label className="field field-inline">
          <span className="field-label">Last</span>
          <select className="input" value={f.hours} onChange={(e) => set("hours", Number(e.target.value))}>
            <option value={1}>hour</option>
            <option value={24}>24 hours</option>
            <option value={168}>7 days</option>
          </select>
        </label>
        {q.data && <span className="filters-count muted">{num(q.data.items.length)} statements</span>}
      </div>
      {q.isLoading && <Loading rows={6} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && q.data.items.length === 0 && <Empty title="No audited statement matches" icon={ScrollText} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap table-wrap-tall">
          <table className="table xa-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Exasol user</th>
                <th scope="col">App user · feature</th>
                <th scope="col">Consumer group</th>
                <th scope="col">SQL</th>
                <th scope="col" className="r">
                  CPU %
                </th>
                <th scope="col" className="r">
                  Temp RAM MiB
                </th>
                <th scope="col" className="r">
                  Seconds
                </th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((s) => (
                <tr key={`${s.session_id}-${s.stmt_id}`}>
                  <td className="nowrap muted">{dateTime(s.started_at)}</td>
                  <td>
                    <code>{s.exa_user}</code>
                  </td>
                  <td className="nowrap">
                    {s.app_user ? (
                      <>
                        <strong>{s.app_user}</strong> <span className="muted">· {s.feature}</span>
                      </>
                    ) : (
                      <span className="muted">untagged</span>
                    )}
                  </td>
                  <td>
                    <span className="pill">{s.consumer_group}</span>
                  </td>
                  <td className="xa-sql" title={s.error ?? undefined}>
                    <code>{bareSql(s.sql)}</code>
                    {s.error && <div className="text-decline xa-small">{s.error}</div>}
                  </td>
                  <td className="r num">{num(s.cpu_pct, 1)}</td>
                  <td className="r num">{num(s.temp_ram_mib, 1)}</td>
                  <td className="r num">{num(s.duration_s, 3)}</td>
                  <td>
                    <Status ok={s.success} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function ExasolAuditPage() {
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Administration" }, { label: "Exasol audit" }]}
        title="Exasol audit"
        lede="Who ran what, proven by the database. Exasol's own audit log records every statement. Each Credora session and statement carries the app user and the screen behind it (credora:<user>:<feature>)."
        actions={
          <span className="muted xa-small">
            <Fingerprint aria-hidden="true" className="xa-icon" /> TLS to Exasol pinned by certificate fingerprint
          </span>
        }
      />
      <ScheduleSection />
      <AnalysisSection />
      <StatementsSection />
    </div>
  );
}
