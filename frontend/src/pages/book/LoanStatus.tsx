import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Download, ListChecks } from "lucide-react";
import type { LoanStatus, LoanStatusEvent, LoanStatusRow } from "../../api/types";
import { LOAN_STATUS_LABEL, useLoanStatus } from "../../api/workflow";
import { DecisionBadge, Empty, ErrorState, Loading, Money, PageHeader, Panel } from "../../components/ui";
import { csvName, downloadCsv, type CsvColumn } from "../../lib/csv";
import { dateTime, num } from "../../lib/format";
import { WithExplain } from "../../explain/Explain";

const ORDER: LoanStatus[] = ["ASSIGNED", "CONTACTED", "NEGOTIATING", "LOAN_TAKEN", "IN_PROGRESS", "DISBURSED", "NOT_INTERESTED"];

export function LoanStatusBadge({ s }: { s: LoanStatus }) {
  return <span className={`loan-status ls-${s.toLowerCase().replace("_", "-")}`}>{LOAN_STATUS_LABEL[s]}</span>;
}

export function StatusHistory({ events }: { events: LoanStatusEvent[] }) {
  if (!events.length) return <p className="small muted">No updates yet.</p>;
  return (
    <ol className="status-history">
      {events.map((e) => (
        <li key={e.event_id}>
          <LoanStatusBadge s={e.status} /> <span className="small muted">{dateTime(e.at)} · {e.actor}</span>
          {e.note && <p className="small">{e.note}</p>}
        </li>
      ))}
    </ol>
  );
}

const CSV: CsvColumn<LoanStatusRow>[] = [
  { header: "CIF", value: (r) => r.cif_id },
  { header: "Company", value: (r) => r.legal_name },
  { header: "RM", value: (r) => r.rm_id },
  { header: "RM name", value: (r) => r.rm_name },
  { header: "Decision", value: (r) => r.decision ?? "" },
  { header: "Offer (INR)", value: (r) => r.offer_amount },
  { header: "Status", value: (r) => LOAN_STATUS_LABEL[r.status] },
  { header: "Last note", value: (r) => r.note ?? "" },
  { header: "Last update", value: (r) => r.updated_at },
  { header: "Updated by", value: (r) => r.updated_by },
  { header: "Assigned by", value: (r) => r.assigned_by },
  { header: "Assigned at", value: (r) => r.assigned_at },
  { header: "History", value: (r) => r.history.map((e) => `${e.at} ${LOAN_STATUS_LABEL[e.status]}${e.note ? `: ${e.note}` : ""}`).join(" | ") },
];

/** Admin, data scientist and loan operations: every assigned company and how its loan is going. */
export function LoanStatusPage() {
  const q = useLoanStatus();
  const [rm, setRm] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const all = q.data ?? [];
  const rms = useMemo(() => [...new Map(all.map((r) => [r.rm_id, r.rm_name])).entries()].sort(), [all]);
  const rows = all.filter((r) => (!rm || r.rm_id === rm) && (!status || r.status === status));
  const counts = ORDER.map((s) => [s, all.filter((r) => r.status === s).length] as const).filter(([, n]) => n > 0);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Credit" }, { label: "Loan status" }]}
        title="Loan status"
        lede={
          <>
            Every company loan operations assigned to a relationship manager, with the status she logs as she talks to the customer:
            Contacted, Negotiating, Loan taken, In progress, Disbursed, or Not interested. Assignments and the status history live in
            Exasol (<code>CREDORA.RM_ASSIGNMENT</code>, <code>CREDORA.LOAN_STATUS_LOG</code>).
          </>
        }
        actions={
          <button className="btn btn-quiet" disabled={!rows.length} onClick={() => downloadCsv(csvName("loan-status"), CSV, rows)}>
            <Download aria-hidden="true" />
            Export CSV
          </button>
        }
      />
      {counts.length > 0 && (
        <div className="status-strip" aria-label="Companies by status">
          {counts.map(([s, n]) => (
            <button key={s} className={`status-chip ${status === s ? "is-on" : ""}`} onClick={() => setStatus(status === s ? "" : s)}>
              <LoanStatusBadge s={s} /> <span className="num strong">{num(n)}</span>
            </button>
          ))}
        </div>
      )}
      <Panel flush>
        <div className="filters">
          <label className="field field-inline">
            <span className="field-label">Relationship manager</span>
            <select className="input" value={rm} onChange={(e) => setRm(e.target.value)}>
              <option value="">All</option>
              {rms.map(([id, name]) => (
                <option key={id} value={id}>
                  {name} ({id})
                </option>
              ))}
            </select>
          </label>
          <label className="field field-inline">
            <span className="field-label">Status</span>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {ORDER.map((s) => (
                <option key={s} value={s}>
                  {LOAN_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <span className="filters-count muted">
            <span className="num">{num(rows.length)}</span> of <span className="num">{num(all.length)}</span> assigned companies
          </span>
        </div>
        {q.isLoading && <Loading rows={8} />}
        {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
        {q.data && rows.length === 0 && (
          <Empty title={all.length ? "No company matches" : "Nothing assigned yet"} icon={ListChecks}>
            {all.length ? "Change the filters." : "Loan operations assigns companies from Decisions or the Top 50."}
          </Empty>
        )}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col"><span className="sr-only">History</span></th>
                  <th scope="col">Company</th>
                  <th scope="col">
                    <WithExplain id="rm-assignment">Relationship manager</WithExplain>
                  </th>
                  <th scope="col">Decision</th>
                  <th scope="col" className="r">Offer</th>
                  <th scope="col">
                    <WithExplain id="loan-status">Status</WithExplain>
                  </th>
                  <th scope="col">Last update</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.cif_id}>
                    <tr>
                      <td>
                        <button
                          className="btn btn-quiet btn-icon btn-sm"
                          aria-expanded={open === r.cif_id}
                          aria-label={`History of ${r.legal_name}`}
                          onClick={() => setOpen(open === r.cif_id ? null : r.cif_id)}
                        >
                          {open === r.cif_id ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                        </button>
                      </td>
                      <td>
                        <Link to={`/companies/${r.cif_id}/report`} className="strong">
                          {r.legal_name || r.cif_id}
                        </Link>
                        <br />
                        <code className="small muted">{r.cif_id}</code>
                      </td>
                      <td>
                        {r.rm_name} <code className="small muted">{r.rm_id}</code>
                      </td>
                      <td>{r.decision ? <DecisionBadge d={r.decision} /> : <span className="muted">–</span>}</td>
                      <td className="r">
                        <Money v={r.offer_amount} short />
                      </td>
                      <td>
                        <LoanStatusBadge s={r.status} />
                        {r.note && r.status !== "ASSIGNED" && <p className="small muted clamp-1">{r.note}</p>}
                      </td>
                      <td className="nowrap small">
                        {dateTime(r.updated_at)}
                        <br />
                        <span className="muted">by {r.updated_by}</span>
                      </td>
                    </tr>
                    {open === r.cif_id && (
                      <tr className="row-detail">
                        <td />
                        <td colSpan={6}>
                          <StatusHistory events={r.history} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
