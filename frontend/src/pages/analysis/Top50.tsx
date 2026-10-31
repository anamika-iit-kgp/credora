import { useState } from "react";
import { Link } from "react-router-dom";
import { CircleCheck, Code, Trophy } from "lucide-react";
import { useRuns, useTop50 } from "../../api/hooks";
import { useUser } from "../../auth/AuthContext";
import { AssignBar, AssignDialog, AssignedRm, SelectCell } from "../../components/Assign";
import { CodeBlock } from "../../components/CodeBlock";
import { PublishedNotice } from "../../components/PublishedNotice";
import { Empty, ErrorState, Grade, Loading, Money, PageHeader, Panel, Stage } from "../../components/ui";
import { dateTime, num, pct, pctFromRatio } from "../../lib/format";
import { can } from "../../lib/roles";
import { WithExplain } from "../../explain/Explain";
import { ExaBadge } from "../../explain/ExaBadge";

const PREFERRING_SQL = `SELECT CIF_ID, PD, RAROC_PCT, OFFER_AMOUNT
FROM   CREDORA.DECISIONS
WHERE  RUN_ID = :run AND DECISION <> 'DECLINE'
PREFERRING LOW PD
       PLUS HIGH RAROC_PCT
       PLUS HIGH OFFER_AMOUNT;`;

export function Top50Page() {
  const user = useUser();
  const canAssign = can(user.role, "assign");
  const [runId, setRunId] = useState("");
  const runsQ = useRuns();
  // Loan operations gets published runs only; the data scientist and the admin also see drafts.
  const done = (runsQ.data ?? [])
    .filter((r) => r.status === "done" && r.finished_at)
    .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));
  const official = done.find((r) => r.published !== false) ?? null;
  const options = official ? [official, ...done.filter((r) => r !== official)] : done;
  const shown = runId ? done.find((r) => r.run_id === runId) : official;
  const q = useTop50(runId);
  const maxPd = Math.max(0.0001, ...(q.data ?? []).map((r) => r.pd));
  const maxR = Math.max(1, ...(q.data ?? []).map((r) => r.raroc));
  // Assignments are made from the official run only.
  const assignable = canAssign && !runId;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [assignFor, setAssignFor] = useState<string[] | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const toggle = (cif: string, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(cif);
      else n.delete(cif);
      return n;
    });
  const all = (q.data ?? []).map((r) => r.cif_id);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Exasol" }, { label: "Top 50" }]}
        title="Top 50"
        lede="Companies no other company beats on all three at once, meaning lower probability of default, higher RAROC and larger amount. Ranked by Exasol's PREFERRING clause."
      />
      <PublishedNotice />
      {doneMsg && (
        <p className="callout callout-approve" role="status">
          <CircleCheck aria-hidden="true" />
          {doneMsg}
        </p>
      )}
      {done.length > 0 && (
        <div className="filters top50-run">
          <label className="field">
            <span className="field-label">Analysis run</span>
            <select className="input" value={runId} onChange={(e) => setRunId(e.target.value)}>
              {options.map((r) => (
                <option key={r.run_id} value={r === official ? "" : r.run_id}>
                  {r.run_id} · {dateTime(r.finished_at)}
                  {r === official ? " · official (published)" : r.published === false ? " · Draft" : " · published"}
                </option>
              ))}
            </select>
          </label>
          {shown && (
            <p className="small muted">
              {shown.published === false && <span className="tag tag-draft">Draft</span>} Run <code>{shown.run_id}</code> · started{" "}
              {dateTime(shown.started_at)} · finished {dateTime(shown.finished_at)} · by {shown.started_by} · model{" "}
              {shown.model_version}
              {shown.published_by ? (
                <>
                  {" "}
                  · published by {shown.published_by}, {dateTime(shown.published_at)}
                </>
              ) : null}
            </p>
          )}
        </div>
      )}
      {assignable && <AssignBar count={sel.size} onAssign={() => setAssignFor([...sel])} onClear={() => setSel(new Set())} />}
      <div className="grid-main-side top50-grid">
        <Panel flush>
          {q.isLoading && <Loading rows={12} />}
          {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
          {q.data && q.data.length === 0 && <Empty title="No ranking yet" icon={Trophy}>The Top 50 appears after the first analysis run.</Empty>}
          {q.data && q.data.length > 0 && (
            <div className="table-wrap table-wrap-tall">
              <table className="table">
                <thead>
                  <tr>
                    {assignable && (
                      <th scope="col" className="sel">
                        <input
                          type="checkbox"
                          aria-label="Select all 50"
                          checked={all.length > 0 && all.every((c) => sel.has(c))}
                          onChange={(e) => all.forEach((c) => toggle(c, e.target.checked))}
                        />
                      </th>
                    )}
                    <th scope="col" className="r">
                      <WithExplain id="preferring-skyline">Rank</WithExplain>
                    </th>
                    <th scope="col">Company</th>
                    <th scope="col">
                      <WithExplain id="grade">Grade</WithExplain>
                    </th>
                    <th scope="col">
                      <WithExplain id="pd">PD</WithExplain>
                    </th>
                    <th scope="col">
                      <WithExplain id="raroc">RAROC</WithExplain>
                    </th>
                    <th scope="col" className="r">Offer</th>
                    <th scope="col">
                      <WithExplain id="offer-stages">Stage</WithExplain>
                    </th>
                    <th scope="col">
                      <WithExplain id="rm-assignment">RM</WithExplain>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.map((r) => (
                    <tr key={r.cif_id} className={sel.has(r.cif_id) ? "is-selected" : undefined}>
                      {assignable && <SelectCell checked={sel.has(r.cif_id)} onChange={(v) => toggle(r.cif_id, v)} label={`Select ${r.legal_name}`} />}
                      <td className="r num strong">{r.rank_no}</td>
                      <td>
                        <Link to={can(user.role, "report") ? `/companies/${r.cif_id}/report` : `/companies/${r.cif_id}`} className="strong">
                          {r.legal_name}
                        </Link>
                        <br />
                        <span className="small muted">{r.industry}</span>
                      </td>
                      <td>
                        <Grade g={r.grade} />
                      </td>
                      <td>
                        <span className="inline-bar">
                          <span className="inline-bar-fill bar-risk" style={{ width: `${(r.pd / maxPd) * 100}%` }} />
                        </span>
                        <span className="num">{pctFromRatio(r.pd)}</span>
                      </td>
                      <td>
                        <span className="inline-bar">
                          <span className="inline-bar-fill bar-return" style={{ width: `${(r.raroc / maxR) * 100}%` }} />
                        </span>
                        <span className="num">{pct(r.raroc, 1)}</span>
                      </td>
                      <td className="r">
                        <Money v={r.offer_amount} short />
                      </td>
                      <td>
                        <Stage s={r.stage} />
                      </td>
                      <td className="nowrap">
                        <AssignedRm rmId={r.assigned_rm_id} />
                        {assignable && (
                          <>
                            {" "}
                            <button className="linklike small" onClick={() => setAssignFor([r.cif_id])}>
                              {r.assigned_rm_id ? "Reassign" : "Assign"}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title={<WithExplain id="preferring-skyline">The query</WithExplain>} icon={Code}>
          <div className="xb-row" style={{ marginBottom: 10 }}>
            <ExaBadge what="Ranked" detail="PREFERRING skyline" term="preferring-skyline" />
            <ExaBadge what="Window function" detail="ROW_NUMBER() MERGE" term="window-functions" />
          </div>
          <CodeBlock code={PREFERRING_SQL} lang="sql" />
          <p className="small muted top-gap">
            <code>PREFERRING</code> keeps the Pareto-best rows. Repeating it on what is left gives each company a layer, and the first
            layers form the Top 50 that goes to the relationship managers.
          </p>
        </Panel>
      </div>
      <AssignDialog
        cifs={assignFor}
        onClose={() => setAssignFor(null)}
        onDone={(r) => {
          setSel(new Set());
          setDoneMsg(`Assigned to ${r.rm_id}. ${num(r.assigned)} new, ${num(r.moved)} moved from another manager, ${num(r.unchanged)} already there.`);
        }}
      />
    </div>
  );
}
