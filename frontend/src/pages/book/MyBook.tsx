import { useState } from "react";
import { Link } from "react-router-dom";
import { BookUser, CircleCheck, FileText, History, PencilLine } from "lucide-react";
import type { LoanStatus, LoanStatusRow } from "../../api/types";
import { LOAN_STATUS_LABEL, NEXT_STATUS, RM_STATUSES, useLoanStatus, useLogStatus } from "../../api/workflow";
import { useUser } from "../../auth/AuthContext";
import { DecisionBadge, Dialog, Empty, ErrorState, Loading, Money, PageHeader, Panel } from "../../components/ui";
import { dateTime, num } from "../../lib/format";
import { LoanStatusBadge, StatusHistory } from "./LoanStatus";
import { WithExplain } from "../../explain/Explain";
import { ExaBadge } from "../../explain/ExaBadge";

/** Relationship manager: the companies loan operations assigned to her, and their loan status. */
export function MyBookPage() {
  const user = useUser();
  const q = useLoanStatus();
  const [edit, setEdit] = useState<LoanStatusRow | null>(null);
  const [hist, setHist] = useState<LoanStatusRow | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const rows = q.data ?? [];
  const open = rows.filter((r) => r.status !== "DISBURSED" && r.status !== "NOT_INTERESTED").length;
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Credit" }, { label: "My companies" }]}
        title="My companies"
        lede={
          <>
            The companies loan operations assigned to you, {user.display_name}, from the latest published run. Exasol returns
            only these rows to your login (<code>CREDORA.V_RM_*</code> views filtered on your Exasol user), at full detail. Talk to each
            customer, negotiate within the limits in the pre-approved offer, and log how it goes.
          </>
        }
      >
        <div className="xb-row">
          <ExaBadge what="Row-level security" detail="V_RM_* on CURRENT_USER" term="row-level-security" />
        </div>
      </PageHeader>
      {saved && (
        <p className="callout callout-approve" role="status">
          <CircleCheck aria-hidden="true" />
          {saved}
        </p>
      )}
      <Panel
        flush
        title={
          <>
            Assigned to you <span className="num muted">{num(rows.length)}</span>
          </>
        }
        icon={BookUser}
        aside={<span className="small muted">{num(open)} still open</span>}
      >
        {q.isLoading && <Loading rows={8} />}
        {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
        {q.data && rows.length === 0 && (
          <Empty title="No companies assigned yet" icon={BookUser}>
            Loan operations assigns companies to you from the published analysis.
          </Empty>
        )}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" className="r">
                    <WithExplain id="rank">Rank</WithExplain>
                  </th>
                  <th scope="col">Company</th>
                  <th scope="col">
                    <WithExplain id="approve-refer-decline">Decision</WithExplain>
                  </th>
                  <th scope="col" className="r">
                    <WithExplain id="pre-approved-offer">Pre-approved offer</WithExplain>
                  </th>
                  <th scope="col">
                    <WithExplain id="loan-status">Loan status</WithExplain>
                  </th>
                  <th scope="col">Last update</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.cif_id}>
                    <td className="r num">{r.rank_no ?? "–"}</td>
                    <td>
                      <Link to={`/companies/${r.cif_id}`} className="strong">
                        {r.legal_name || r.cif_id}
                      </Link>
                      <br />
                      <code className="small muted">{r.cif_id}</code>
                    </td>
                    <td>{r.decision ? <DecisionBadge d={r.decision} /> : <span className="muted">–</span>}</td>
                    <td className="r">
                      <Money v={r.offer_amount} short />
                    </td>
                    <td>
                      <LoanStatusBadge s={r.status} />
                    </td>
                    <td className="nowrap small">
                      {dateTime(r.updated_at)}
                      <br />
                      <span className="muted">by {r.updated_by}</span>
                    </td>
                    <td className="nowrap r">
                      <Link to={`/companies/${r.cif_id}/report`} className="btn btn-quiet btn-sm">
                        <FileText aria-hidden="true" />
                        Report
                      </Link>{" "}
                      <button className="btn btn-quiet btn-sm" onClick={() => setHist(r)}>
                        <History aria-hidden="true" />
                        History
                      </button>{" "}
                      <button className="btn btn-primary btn-sm" disabled={nextOf(r).length === 0} onClick={() => setEdit(r)}>
                        <PencilLine aria-hidden="true" />
                        Update status
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <StatusDialog
        row={edit}
        onClose={() => setEdit(null)}
        onSaved={(s, r) => setSaved(`${r.legal_name || r.cif_id} is now ${LOAN_STATUS_LABEL[s]}, logged ${dateTime(new Date().toISOString())}.`)}
      />
      <Dialog
        open={!!hist}
        onClose={() => setHist(null)}
        title={hist ? `Loan status history of ${hist.legal_name || hist.cif_id}` : ""}
        footer={
          <button className="btn btn-quiet" onClick={() => setHist(null)}>
            Close
          </button>
        }
      >
        {hist && <StatusHistory events={hist.history} />}
      </Dialog>
    </div>
  );
}

/** The statuses the RM can log next: the backend's list, or the state machine if an older backend sent none. */
const nextOf = (r: LoanStatusRow): LoanStatus[] => r.next_statuses ?? NEXT_STATUS[r.status] ?? [];

function StatusDialog({ row, onClose, onSaved }: { row: LoanStatusRow | null; onClose: () => void; onSaved: (s: LoanStatus, r: LoanStatusRow) => void }) {
  const [status, setStatus] = useState<LoanStatus | "">("");
  const [note, setNote] = useState("");
  const m = useLogStatus();
  if (!row) return null;
  const done = () => {
    m.reset();
    setStatus("");
    setNote("");
    onClose();
  };
  return (
    <Dialog
      open={!!row}
      onClose={done}
      title={`Update loan status of ${row.legal_name || row.cif_id}`}
      footer={
        <>
          <button className="btn btn-quiet" onClick={done}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!status || !note.trim() || m.isPending}
            onClick={() =>
              status &&
              m.mutate(
                { cif: row.cif_id, status, note: note.trim() },
                {
                  onSuccess: () => {
                    onSaved(status, row);
                    done();
                  },
                },
              )
            }
          >
            {m.isPending ? "Saving…" : "Log status"}
          </button>
        </>
      }
    >
      <p className="small muted">
        Now <LoanStatusBadge s={row.status} /> since {dateTime(row.updated_at)}. Every update is kept with its note and time. The status
        moves one step at a time. Loan taken needs terms agreed within the negotiation limits, or sanctioned by loan operations.
      </p>
      {row.offer_block && (
        <p className="small muted">
          {row.offer_block}
          {row.offer_id ? (
            <>
              {" "}
              <Link to={`/offers/${row.offer_id}`}>Open the offer</Link>
            </>
          ) : null}
        </p>
      )}
      <fieldset className="status-pick">
        <legend className="field-label">New status</legend>
        {RM_STATUSES.map((s) => (
          <label key={s} className={`status-opt ${status === s ? "is-on" : ""}`}>
            <input type="radio" name="status" value={s} checked={status === s} disabled={!nextOf(row).includes(s)} onChange={() => setStatus(s)} />
            <LoanStatusBadge s={s} />
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="field-label">Note (required)</span>
        <textarea
          className="input"
          rows={3}
          maxLength={400}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What the customer said, next step"
        />
      </label>
      {m.isError && (
        <p className="form-error" role="alert">
          {(m.error as Error).message}
        </p>
      )}
    </Dialog>
  );
}
