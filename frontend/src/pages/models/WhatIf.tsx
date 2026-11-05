import { useEffect, useRef, useState } from "react";
import { Download, FileCheck, History, RotateCcw, Save, Scale, Send, SlidersHorizontal } from "lucide-react";
import { useWhatIf } from "../../api/hooks";
import { useProposals, useSaveWhatIfRun, useWhatIfRuns } from "../../api/policy";
import type { Decision, DecisionMix, PolicyProposal, WhatIfRun } from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { SortableTh, useSort } from "../../components/SortableTh";
import { DecisionBadge, Empty, ErrorState, Loading, MixBar, PageHeader, Panel } from "../../components/ui";
import { csvName, downloadCsv, type CsvColumn } from "../../lib/csv";
import { dateTime, duration, num, rupeesShort } from "../../lib/format";
import { can } from "../../lib/roles";
import type { SortColumns } from "../../lib/sort";
import { changesOf, LeverDiff, pctLever, ProposalStatus, ProposeDialog, sameBaseline } from "./PolicyParts";
import { Explain, WithExplain } from "../../explain/Explain";
import { ExaBadge } from "../../explain/ExaBadge";

interface Lever {
  key: "hurdle_pct" | "eblr_pct" | "max_gst_share_pct";
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  base: number;
}

const LEVERS: Lever[] = [
  { key: "hurdle_pct", label: "RAROC hurdle", help: "The return on risk capital a loan must clear to be approved.", min: 8, max: 25, step: 0.5, base: 15 },
  { key: "eblr_pct", label: "EBLR", help: "External benchmark lending rate that every ROI is built on. Policy caps ROI at 14.5%.", min: 6.5, max: 11, step: 0.05, base: 8.25 },
  { key: "max_gst_share_pct", label: "Maximum share of GST turnover", help: "Upper bound on the amount, as a share of 12-month GST turnover.", min: 10, max: 35, step: 1, base: 20 },
];

type Params = Record<Lever["key"], number>;
/** Explain mode: the glossary term behind each lever. */
const LEVER_TERM: Record<Lever["key"], string> = { hurdle_pct: "hurdle-rate", eblr_pct: "eblr", max_gst_share_pct: "gst-returns" };
const DEFAULTS = Object.fromEntries(LEVERS.map((l) => [l.key, l.base])) as Params;
const keyOf = (x: Params) => LEVERS.map((l) => x[l.key]).join("|");

export function WhatIfPage() {
  const user = useUser();
  const canPropose = can(user.role, "proposePolicy");
  const [p, setP] = useState<Params>(DEFAULTS);
  // The policy in force (CREDORA.CONFIG), from the server: changes when the admin approves a proposal.
  const [policy, setPolicy] = useState<Params | null>(null);
  const run = useWhatIf();
  const sent = useRef("");
  const save = useSaveWhatIfRun();
  const runs = useWhatIfRuns();
  const proposals = useProposals(canPropose);
  const [saved, setSaved] = useState<WhatIfRun | null>(null);
  const [proposeFor, setProposeFor] = useState<WhatIfRun | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);

  // First call has no overrides, so its answer carries the policy in force; the levers start there.
  const init = () =>
    run.mutate(
      {},
      {
        onSuccess: (r) => {
          const b = r.baseline as Params;
          sent.current = keyOf(b);
          setPolicy(b);
          setP(b);
        },
      },
    );
  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!policy || keyOf(p) === sent.current) return;
    const t = setTimeout(() => {
      sent.current = keyOf(p);
      run.mutate(p);
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, p.hurdle_pct, p.eblr_pct, p.max_gst_share_pct]);

  const res = run.data;
  useEffect(() => {
    if (res && policy && keyOf(res.baseline as Params) !== keyOf(policy)) setPolicy(res.baseline as Params);
  }, [res, policy]);

  const base = (l: Lever) => policy?.[l.key] ?? l.base;
  const changed = LEVERS.some((l) => p[l.key] !== base(l));
  const savedNow = saved && keyOf(saved.levers as Params) === keyOf(p) ? saved : null;
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Exasol" }, { label: "What-if" }]}
        title="What-if"
        lede={
          <>
            Change a policy lever and see how every decision would move. Exasol re-runs the decision step of <code>CREDORA.RUN_ANALYSIS</code>
            over the latest features and scores in one query. Save a run to keep it, then send it to the admin for approval. Nothing
            changes the policy until the admin approves.
          </>
        }
        actions={
          <button className="btn btn-quiet" disabled={!policy} onClick={() => policy && setP({ ...policy })}>
            <RotateCcw aria-hidden="true" />
            Reset to policy
          </button>
        }
      />
      <div className="grid-side-main">
        <Panel title="Policy levers" icon={SlidersHorizontal}>
          <div className="levers">
            {LEVERS.map((l) => (
              <div key={l.key} className="lever">
                <div className="lever-head">
                  <label htmlFor={`lv-${l.key}`} className="field-label">
                    {l.label}
                    <Explain id={LEVER_TERM[l.key] ?? "policy-config"} label={l.label} />
                  </label>
                  <span className="lever-value num">
                    <input
                      className="input input-num"
                      type="number"
                      min={l.min}
                      max={l.max}
                      step={l.step}
                      value={p[l.key]}
                      aria-label={`${l.label}, percent`}
                      onChange={(e) => setP({ ...p, [l.key]: Number(e.target.value) })}
                    />
                    %
                  </span>
                </div>
                <input
                  id={`lv-${l.key}`}
                  type="range"
                  className="range"
                  min={l.min}
                  max={l.max}
                  step={l.step}
                  value={p[l.key]}
                  onChange={(e) => setP({ ...p, [l.key]: Number(e.target.value) })}
                />
                <p className="field-help">
                  {l.help} Current policy is <span className="num">{base(l)}%</span>
                  {p[l.key] !== base(l) && (
                    <span className="lever-changed">
                      {" "}
                      · now {p[l.key] > base(l) ? "+" : "−"}
                      {Math.abs(p[l.key] - base(l)).toFixed(2).replace(/\.?0+$/, "")} pts
                    </span>
                  )}
                </p>
              </div>
            ))}
          </div>
        </Panel>
        <Panel
          title={<WithExplain id="what-if">Effect on decisions</WithExplain>}
          icon={Scale}
          aside={run.isPending ? <span className="muted small">Recalculating…</span> : <ExaBadge what="Computed in Exasol" detail="one SELECT, nothing written" />}
        >
          {run.isError && <ErrorState error={run.error} retry={() => (policy ? run.mutate(p) : init())} />}
          {res && (
            <div className={`whatif ${run.isPending ? "is-refreshing" : ""}`}>
              <div className="whatif-row">
                <p className="whatif-label">Current policy</p>
                <MixBar mix={res.before} label="Current policy" />
              </div>
              <div className="whatif-row">
                <p className="whatif-label">With these levers</p>
                <MixBar mix={res.after} label="With these levers" />
              </div>
              <DeltaTable before={res.before} after={res.after} beforeAmount={res.before_amount} afterAmount={res.after_amount} />
              {canPropose && (
                <div className="whatif-actions">
                  <button
                    className="btn btn-primary"
                    disabled={!policy || save.isPending || !!savedNow}
                    onClick={() => save.mutate(p, { onSuccess: (r) => setSaved(r) })}
                  >
                    <Save aria-hidden="true" />
                    {save.isPending ? "Saving…" : savedNow ? `Saved as ${savedNow.run_id}` : "Save run"}
                  </button>
                  {savedNow && changed && !savedNow.proposal && (
                    <button className="btn btn-quiet" onClick={() => setProposeFor(savedNow)}>
                      <Send aria-hidden="true" />
                      Send to admin for approval
                    </button>
                  )}
                  <Explain id="policy-proposal" label="Send to admin for approval" />
                  <span className="small muted">
                    {savedNow
                      ? changed
                        ? `Run ${savedNow.run_id} is in Earlier runs below.`
                        : "These are the current policy values. There is nothing to propose."
                      : "Saves the levers and the outcome as a what-if run."}
                  </span>
                </div>
              )}
              {save.isError && (
                <p className="form-error" role="alert">
                  {(save.error as Error).message}
                </p>
              )}
            </div>
          )}
          {!res && !run.isError && <p className="muted">Calculating…</p>}
        </Panel>
      </div>
      {sentNote && (
        <p className="callout callout-approve" role="status">
          <FileCheck aria-hidden="true" />
          {sentNote}
        </p>
      )}
      <EarlierRuns
        runs={runs.data}
        loading={runs.isLoading}
        error={runs.error}
        policy={policy}
        canPropose={canPropose}
        onPropose={setProposeFor}
      />
      {canPropose && <MyProposals list={proposals.data} loading={proposals.isLoading} error={proposals.error} />}
      <ProposeDialog
        run={proposeFor}
        onClose={() => setProposeFor(null)}
        onSent={(id) => {
          setSentNote(`Proposal #${id} sent. The admin sees it under Policy approvals, and its status is shown below.`);
          setSaved((s) => (s && proposeFor && s.run_id === proposeFor.run_id ? { ...s, proposal: { proposal_id: id, status: "PENDING" } } : s));
        }}
      />
    </div>
  );
}

const leverCell = (r: WhatIfRun, k: Lever["key"]) => (
  <td className={`r num ${r.levers[k] !== r.baseline[k] ? "lever-changed" : ""}`}>{pctLever(r.levers[k])}</td>
);

function proposalWord(r: WhatIfRun) {
  if (!r.proposal) return changesOf(r).length ? "" : "Current policy";
  const s = r.proposal.status;
  return `#${r.proposal.proposal_id} ${s.charAt(0)}${s.slice(1).toLowerCase()}`;
}

/** Exactly the columns of the Earlier runs table, levers included. */
const RUN_CSV: CsvColumn<WhatIfRun>[] = [
  { header: "Run", value: (r) => r.run_id },
  { header: "Analysis run", value: (r) => r.base_run_id },
  { header: "Started", value: (r) => r.created_at },
  { header: "By", value: (r) => r.created_by },
  { header: "Model", value: (r) => r.model_version },
  { header: "RAROC hurdle %", value: (r) => r.levers.hurdle_pct },
  { header: "EBLR %", value: (r) => r.levers.eblr_pct },
  { header: "Max GST share %", value: (r) => r.levers.max_gst_share_pct },
  { header: "Approve", value: (r) => r.after.APPROVE },
  { header: "Refer", value: (r) => r.after.REFER },
  { header: "Decline", value: (r) => r.after.DECLINE },
  { header: "Pre-approved offers (INR)", value: (r) => r.after_amount },
  { header: "Time (ms)", value: (r) => r.ms },
  { header: "Proposal", value: proposalWord },
];

const RUN_SORT: SortColumns<WhatIfRun> = {
  run_id: (r) => r.run_id,
  created_at: (r) => r.created_at,
  created_by: (r) => r.created_by,
  model_version: (r) => r.model_version,
  hurdle_pct: (r) => r.levers.hurdle_pct,
  eblr_pct: (r) => r.levers.eblr_pct,
  max_gst_share_pct: (r) => r.levers.max_gst_share_pct,
  approve: (r) => r.after.APPROVE,
  refer: (r) => r.after.REFER,
  decline: (r) => r.after.DECLINE,
  after_amount: (r) => r.after_amount,
  ms: (r) => r.ms,
  proposal: (r) => r.proposal?.status,
};

function EarlierRuns({
  runs,
  loading,
  error,
  policy,
  canPropose,
  onPropose,
}: {
  runs: WhatIfRun[] | undefined;
  loading: boolean;
  error: unknown;
  policy: Params | null;
  canPropose: boolean;
  onPropose: (r: WhatIfRun) => void;
}) {
  const sort = useSort(runs ?? [], RUN_SORT);
  return (
    <Panel
      title="Earlier runs"
      icon={History}
      flush
      aside={
        <button
          className="btn btn-quiet btn-sm"
          disabled={!runs?.length}
          onClick={() => runs && downloadCsv(csvName("whatif-runs"), RUN_CSV, [...sort.rows])}
          title="Download the rows below as a CSV file"
        >
          <Download aria-hidden="true" />
          Export CSV
        </button>
      }
    >
      {loading && <Loading rows={3} />}
      {!!error && <ErrorState error={error} />}
      {runs && runs.length === 0 && (
        <Empty title="No saved runs yet" icon={History}>
          Move a lever and choose Save run. Each saved run keeps its levers and outcome.
        </Empty>
      )}
      {runs && runs.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <SortableTh sortKey="run_id" control={sort}>Run</SortableTh>
                <SortableTh sortKey="created_at" control={sort}>Started</SortableTh>
                <SortableTh sortKey="created_by" control={sort}>By</SortableTh>
                <SortableTh sortKey="model_version" control={sort}>Model</SortableTh>
                <SortableTh sortKey="hurdle_pct" control={sort} className="r">Hurdle</SortableTh>
                <SortableTh sortKey="eblr_pct" control={sort} className="r">EBLR</SortableTh>
                <SortableTh sortKey="max_gst_share_pct" control={sort} className="r">GST share</SortableTh>
                <SortableTh sortKey="approve" control={sort} className="r">Approve</SortableTh>
                <SortableTh sortKey="refer" control={sort} className="r">Refer</SortableTh>
                <SortableTh sortKey="decline" control={sort} className="r">Decline</SortableTh>
                <SortableTh sortKey="after_amount" control={sort} className="r">Pre-approved</SortableTh>
                <SortableTh sortKey="ms" control={sort} className="r">Time</SortableTh>
                <SortableTh sortKey="proposal" control={sort}>Proposal</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sort.rows.map((r) => {
                const proposable = changesOf(r).length > 0;
                const current = sameBaseline(r, policy);
                return (
                  <tr key={r.run_id}>
                    <td>
                      <code>{r.run_id}</code>
                      <br />
                      <span className="small muted">
                        on <code>{r.base_run_id}</code>
                      </span>
                    </td>
                    <td className="nowrap">{dateTime(r.created_at)}</td>
                    <td>
                      <code>{r.created_by}</code>
                    </td>
                    <td>
                      <code>{r.model_version}</code>
                    </td>
                    {leverCell(r, "hurdle_pct")}
                    {leverCell(r, "eblr_pct")}
                    {leverCell(r, "max_gst_share_pct")}
                    <td className="r num text-approve">{num(r.after.APPROVE)}</td>
                    <td className="r num text-refer">{num(r.after.REFER)}</td>
                    <td className="r num text-decline">{num(r.after.DECLINE)}</td>
                    <td className="r num">{rupeesShort(r.after_amount)}</td>
                    <td className="r num">{r.ms == null ? "–" : duration(r.ms)}</td>
                    <td className="nowrap">
                      {r.proposal ? (
                        <>
                          <ProposalStatus s={r.proposal.status} /> <span className="small muted">#{r.proposal.proposal_id}</span>
                        </>
                      ) : !proposable ? (
                        <span className="small muted">Current policy</span>
                      ) : canPropose ? (
                        <button
                          className="btn btn-quiet btn-sm"
                          disabled={!current}
                          title={current ? undefined : "Policy changed since this run. Run it again with the current policy."}
                          onClick={() => onPropose(r)}
                        >
                          <Send aria-hidden="true" />
                          Send to admin
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const PROPOSAL_SORT: SortColumns<PolicyProposal> = {
  proposal_id: (x) => x.proposal_id,
  created_at: (x) => x.created_at,
  status: (x) => x.status,
  decided_at: (x) => x.decided_at,
};

function MyProposals({ list, loading, error }: { list: PolicyProposal[] | undefined; loading: boolean; error: unknown }) {
  const sort = useSort(list ?? [], PROPOSAL_SORT);
  return (
    <Panel title="My policy proposals" icon={FileCheck} flush aside={<span className="small muted">The admin approves or rejects each one</span>}>
      {loading && <Loading rows={2} />}
      {!!error && <ErrorState error={error} />}
      {list && list.length === 0 && (
        <Empty title="No proposals yet" icon={FileCheck}>
          Send a saved run to the admin and its status appears here.
        </Empty>
      )}
      {list && list.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <SortableTh sortKey="proposal_id" control={sort}>Proposal</SortableTh>
                <SortableTh sortKey="created_at" control={sort}>Sent</SortableTh>
                <th scope="col">Changes</th>
                <SortableTh sortKey="status" control={sort}>Status</SortableTh>
                <SortableTh sortKey="decided_at" control={sort}>Decision</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sort.rows.map((x) => (
                <tr key={x.proposal_id}>
                  <td>
                    <span className="strong">#{x.proposal_id}</span>
                    <br />
                    <span className="small muted">
                      run <code>{x.run_id}</code>
                    </span>
                  </td>
                  <td className="nowrap">{dateTime(x.created_at)}</td>
                  <td className="policy-changes">
                    <LeverDiff levers={x.levers} />
                  </td>
                  <td className="nowrap">
                    <ProposalStatus s={x.status} />
                  </td>
                  <td>
                    {x.status === "PENDING" ? (
                      <span className="small muted">{x.baseline_changed ? "Policy changed since, so it cannot be approved." : "Waiting for the admin"}</span>
                    ) : (
                      <span className="small">
                        <code>{x.decided_by}</code>, {dateTime(x.decided_at)}
                        {x.decision_note && <>, with the note “{x.decision_note}”</>}
                        {x.applied_run_id && (
                          <>
                            <br />
                            <span className="muted">
                              Applied by analysis run <code>{x.applied_run_id}</code>
                            </span>
                          </>
                        )}
                      </span>
                    )}
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

function DeltaTable({
  before,
  after,
  beforeAmount,
  afterAmount,
}: {
  before: DecisionMix;
  after: DecisionMix;
  beforeAmount?: number;
  afterAmount?: number;
}) {
  const ds: Decision[] = ["APPROVE", "REFER", "DECLINE"];
  return (
    <table className="table whatif-table">
      <thead>
        <tr>
          <th scope="col">Decision</th>
          <th scope="col" className="r">Before</th>
          <th scope="col" className="r">After</th>
          <th scope="col" className="r">Change</th>
        </tr>
      </thead>
      <tbody>
        {ds.map((d) => {
          const delta = after[d] - before[d];
          return (
            <tr key={d}>
              <td>
                <DecisionBadge d={d} />
              </td>
              <td className="r num">{num(before[d])}</td>
              <td className="r num strong">{num(after[d])}</td>
              <td className={`r num ${delta === 0 ? "muted" : ""}`}>{delta === 0 ? "no change" : `${delta > 0 ? "+" : "−"}${num(Math.abs(delta))}`}</td>
            </tr>
          );
        })}
        {beforeAmount != null && afterAmount != null && (
          <tr>
            <td>Pre-approved offers, total</td>
            <td className="r num">{rupeesShort(beforeAmount)}</td>
            <td className="r num strong">{rupeesShort(afterAmount)}</td>
            <td className={`r num ${afterAmount === beforeAmount ? "muted" : ""}`}>
              {afterAmount === beforeAmount ? "no change" : `${afterAmount > beforeAmount ? "+" : "−"}${rupeesShort(Math.abs(afterAmount - beforeAmount))}`}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
