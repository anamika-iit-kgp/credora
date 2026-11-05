import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CircleCheck, SearchX } from "lucide-react";
import { useDecisions } from "../../api/hooks";
import { useUser } from "../../auth/AuthContext";
import { AssignBar, AssignDialog, AssignedRm, SelectCell } from "../../components/Assign";
import { PublishedNotice } from "../../components/PublishedNotice";
import { SortableTh, useUrlSort } from "../../components/SortableTh";
import { DecisionBadge, Empty, ErrorState, Grade, Loading, Money, PageHeader, Pager, Panel, Segmented } from "../../components/ui";
import { months, num, pct, pctFromRatio } from "../../lib/format";
import { can } from "../../lib/roles";

// The list is paginated, so the server sorts it. backend/app/routes/analysis.py holds the same keys.
const SORT_KEYS = ["rank_no", "legal_name", "decision", "grade", "pd", "raroc", "offer_amount", "offer_roi", "offer_tenure", "assigned_rm_id"];
const GRADES = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2"];

export function DecisionsPage() {
  const user = useUser();
  const canAssign = can(user.role, "assign");
  const [sp, setSp] = useSearchParams();
  const decision = sp.get("decision") ?? "";
  const grade = sp.get("grade") ?? "";
  const assigned = sp.get("assigned") ?? "";
  const page = Number(sp.get("page") ?? 1);
  const sort = useUrlSort(SORT_KEYS);
  const q = useDecisions({ decision, grade, assigned, page, sort: sort.sort?.key, order: sort.sort?.dir });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [assignFor, setAssignFor] = useState<string[] | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const toggle = (cif: string, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(cif);
      else n.delete(cif);
      return n;
    });
  const pageCifs = q.data?.items.map((d) => d.cif_id) ?? [];
  const allOnPage = pageCifs.length > 0 && pageCifs.every((c) => sel.has(c));
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== "page") n.delete("page");
    setSp(n, { replace: true });
  };

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Exasol" }, { label: "Decisions" }]}
        title="Decisions"
        lede={
          <>
            Every company from the latest published run, in rank order. Read from <code>CREDORA.DECISIONS</code>
            {canAssign ? (
              <>
                . Select companies and assign them to a relationship manager (<code>CREDORA.RM_ASSIGNMENT</code>).
              </>
            ) : (
              "."
            )}
          </>
        }
      />
      <PublishedNotice />
      {done && (
        <p className="callout callout-approve" role="status">
          <CircleCheck aria-hidden="true" />
          {done}
        </p>
      )}
      <Panel flush>
        <div className="filters">
          <Segmented
            label="Decision"
            value={decision}
            onChange={(v) => set("decision", v)}
            options={[
              { value: "", label: "All" },
              { value: "APPROVE", label: "Approve" },
              { value: "REFER", label: "Refer" },
              { value: "DECLINE", label: "Decline" },
            ]}
          />
          <label className="field field-inline">
            <span className="field-label">Grade</span>
            <select className="input" value={grade} onChange={(e) => set("grade", e.target.value)}>
              <option value="">All</option>
              {GRADES.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </label>
          <Segmented
            label="Assignment"
            value={assigned}
            onChange={(v) => set("assigned", v)}
            options={[
              { value: "", label: "Any RM" },
              { value: "no", label: "Not assigned" },
              { value: "yes", label: "Assigned" },
            ]}
          />
          {q.data && (
            <span className="filters-count muted">
              <span className="num">{num(q.data.total)}</span> decisions
            </span>
          )}
        </div>
        {canAssign && <AssignBar count={sel.size} onAssign={() => setAssignFor([...sel])} onClear={() => setSel(new Set())} />}
        {q.isLoading && <Loading rows={10} />}
        {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
        {q.data && q.data.items.length === 0 && <Empty title="No decisions match" icon={SearchX}>Change the filters, or run the analysis if none exist yet.</Empty>}
        {q.data && q.data.items.length > 0 && (
          <>
            <div className={`table-wrap ${q.isFetching ? "is-refreshing" : ""}`}>
              <table className="table">
                <thead>
                  <tr>
                    {canAssign && (
                      <th scope="col" className="sel">
                        <input
                          type="checkbox"
                          aria-label="Select every company on this page"
                          checked={allOnPage}
                          onChange={(e) => pageCifs.forEach((c) => toggle(c, e.target.checked))}
                        />
                      </th>
                    )}
                    <SortableTh sortKey="rank_no" control={sort} className="r" explain="rank">Rank</SortableTh>
                    <SortableTh sortKey="legal_name" control={sort}>Company</SortableTh>
                    <SortableTh sortKey="decision" control={sort} explain="approve-refer-decline">Decision</SortableTh>
                    <SortableTh sortKey="grade" control={sort} explain="grade">Grade</SortableTh>
                    <SortableTh sortKey="pd" control={sort} className="r" explain="pd">PD</SortableTh>
                    <SortableTh sortKey="raroc" control={sort} className="r" explain="raroc">RAROC</SortableTh>
                    <SortableTh sortKey="offer_amount" control={sort} className="r" explain="pre-approved-offer">Offer</SortableTh>
                    <SortableTh sortKey="offer_roi" control={sort} className="r" explain="roi">ROI</SortableTh>
                    <SortableTh sortKey="offer_tenure" control={sort} className="r">Tenure</SortableTh>
                    <SortableTh sortKey="assigned_rm_id" control={sort} explain="rm-assignment">RM</SortableTh>
                    <th scope="col"><span className="sr-only">Report</span></th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((d) => (
                    <tr key={d.cif_id} className={sel.has(d.cif_id) ? "is-selected" : undefined}>
                      {canAssign && <SelectCell checked={sel.has(d.cif_id)} onChange={(v) => toggle(d.cif_id, v)} label={`Select ${d.legal_name}`} />}
                      <td className="r num">{d.rank_no}</td>
                      <td>
                        <Link to={`/companies/${d.cif_id}`} className="strong">
                          {d.legal_name}
                        </Link>
                        <br />
                        <code className="small muted">{d.cif_id}</code>
                      </td>
                      <td>
                        <DecisionBadge d={d.decision} />
                      </td>
                      <td>
                        <Grade g={d.grade} />
                      </td>
                      <td className="r num">{pctFromRatio(d.pd)}</td>
                      <td className="r num">{d.raroc != null ? pct(d.raroc, 1) : "–"}</td>
                      <td className="r">
                        <Money v={d.offer_amount} short />
                      </td>
                      <td className="r num">{pct(d.offer_roi)}</td>
                      <td className="r num">{months(d.offer_tenure)}</td>
                      <td>
                        <AssignedRm rmId={d.assigned_rm_id} />
                      </td>
                      <td className="nowrap">
                        <Link to={`/companies/${d.cif_id}/report`} className="small">
                          Report
                        </Link>
                        {canAssign && (
                          <>
                            {" · "}
                            <button className="linklike small" onClick={() => setAssignFor([d.cif_id])}>
                              {d.assigned_rm_id ? "Reassign" : "Assign"}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={q.data.page} size={q.data.size} total={q.data.total} onPage={(p) => set("page", String(p))} />
          </>
        )}
      </Panel>
      <AssignDialog
        cifs={assignFor}
        onClose={() => setAssignFor(null)}
        onDone={(r) => {
          setSel(new Set());
          setDone(`Assigned to ${r.rm_id}. ${num(r.assigned)} new, ${num(r.moved)} moved from another manager, ${num(r.unchanged)} already there.`);
        }}
      />
    </div>
  );
}
