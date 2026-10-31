// Shared by the What-if page (datasci proposes) and Policy approvals (admin decides).
import { useState } from "react";
import { Send } from "lucide-react";
import { useCreateProposal } from "../../api/policy";
import type { Decision, OutcomeMix, PolicyLeverChange, ProposalStatus as Status, WhatIfParams, WhatIfRun } from "../../api/types";
import { DecisionBadge, Dialog } from "../../components/ui";
import { num, rupeesShort } from "../../lib/format";

export const LEVER_LABEL: Record<keyof WhatIfParams, { label: string; key: string }> = {
  hurdle_pct: { label: "RAROC hurdle", key: "HURDLE_PCT" },
  eblr_pct: { label: "EBLR", key: "EBLR_PCT" },
  max_gst_share_pct: { label: "Maximum share of GST turnover", key: "MAX_GST_SHARE_PCT" },
};

/** 15 -> "15%", 8.25 -> "8.25%" */
export const pctLever = (v: number | null | undefined) => (v == null ? "–" : `${Number(v.toFixed(2))}%`);

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** The levers a saved what-if run moved away from the policy it was run against. */
export function changesOf(run: WhatIfRun): PolicyLeverChange[] {
  return (Object.keys(LEVER_LABEL) as (keyof WhatIfParams)[])
    .filter((k) => !close(run.levers[k], run.baseline[k]))
    .map((k) => ({ key: LEVER_LABEL[k].key, lever: k, label: LEVER_LABEL[k].label, old: run.baseline[k], new: run.levers[k] }));
}

export function sameBaseline(run: WhatIfRun, policy: Required<WhatIfParams> | null | undefined) {
  if (!policy) return true;
  return (Object.keys(LEVER_LABEL) as (keyof WhatIfParams)[]).every((k) => close(run.baseline[k], policy[k]));
}

const STATUS: Record<Status, { word: string; cls: string }> = {
  PENDING: { word: "Pending", cls: "escalated" },
  APPROVED: { word: "Approved", cls: "sanctioned" },
  REJECTED: { word: "Rejected", cls: "declined" },
};

export function ProposalStatus({ s }: { s: Status }) {
  return <span className={`stage stage-${STATUS[s].cls}`}>{STATUS[s].word}</span>;
}

function signed(d: number, fmt: (n: number) => string) {
  if (close(d, 0)) return <span className="muted">no change</span>;
  return (
    <>
      {d > 0 ? "+" : "−"}
      {fmt(Math.abs(d))}
    </>
  );
}

/** CONFIG key, current value, proposed value. */
export function LeverDiff({ levers }: { levers: PolicyLeverChange[] }) {
  return (
    <table className="table policy-table">
      <thead>
        <tr>
          <th scope="col">Lever</th>
          <th scope="col" className="r">Current</th>
          <th scope="col" className="r">Proposed</th>
          <th scope="col" className="r">Change</th>
        </tr>
      </thead>
      <tbody>
        {levers.map((l) => (
          <tr key={l.key}>
            <td>
              {l.label}
              <br />
              <code className="small muted">CREDORA.CONFIG.{l.key}</code>
            </td>
            <td className="r num">{pctLever(l.old)}</td>
            <td className="r num strong">{pctLever(l.new)}</td>
            <td className="r num">{signed(l.new - l.old, (n) => `${Number(n.toFixed(2))} pts`)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Approve / refer / decline counts and the pre-approved amount: official run vs proposed policy. */
export function OutcomeCompare({ current, proposed, baseRunId }: { current: OutcomeMix; proposed: OutcomeMix; baseRunId: string }) {
  const ds: Decision[] = ["APPROVE", "REFER", "DECLINE"];
  return (
    <table className="table policy-table">
      <thead>
        <tr>
          <th scope="col">Outcome</th>
          <th scope="col" className="r">
            Official run <code className="small">{baseRunId}</code>
          </th>
          <th scope="col" className="r">Proposed</th>
          <th scope="col" className="r">Change</th>
        </tr>
      </thead>
      <tbody>
        {ds.map((d) => (
          <tr key={d}>
            <td>
              <DecisionBadge d={d} />
            </td>
            <td className="r num">{num(current[d])}</td>
            <td className="r num strong">{num(proposed[d])}</td>
            <td className="r num">{signed(proposed[d] - current[d], (n) => num(n))}</td>
          </tr>
        ))}
        {current.amount != null && proposed.amount != null && (
          <tr>
            <td>Pre-approved offers, total</td>
            <td className="r num">{rupeesShort(current.amount)}</td>
            <td className="r num strong">{rupeesShort(proposed.amount)}</td>
            <td className="r num">{signed(proposed.amount - current.amount, rupeesShort)}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export const outcomeOf = (run: WhatIfRun) => ({
  base_run_id: run.base_run_id,
  current: { ...run.before, amount: run.before_amount },
  proposed: { ...run.after, amount: run.after_amount },
});

/** Data scientist: send a saved what-if run to the admin as a policy proposal. */
export function ProposeDialog({ run, onClose, onSent }: { run: WhatIfRun | null; onClose: () => void; onSent?: (id: number) => void }) {
  const [note, setNote] = useState("");
  const m = useCreateProposal();
  if (!run) return null;
  const changes = changesOf(run);
  const o = outcomeOf(run);
  const done = () => {
    m.reset();
    setNote("");
    onClose();
  };
  return (
    <Dialog
      open={!!run}
      onClose={done}
      title={`Send what-if run ${run.run_id} to the admin for approval`}
      footer={
        <>
          <button className="btn btn-quiet" onClick={done}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!note.trim() || m.isPending || changes.length === 0}
            onClick={() =>
              m.mutate(
                { run_id: run.run_id, note: note.trim() },
                {
                  onSuccess: (p) => {
                    onSent?.(p.proposal_id);
                    done();
                  },
                },
              )
            }
          >
            <Send aria-hidden="true" />
            {m.isPending ? "Sending…" : "Send for approval"}
          </button>
        </>
      }
    >
      <p className="small muted">
        The admin approves or rejects it. On approval these values are written to <code>CREDORA.CONFIG</code> and the full analysis
        runs again, so decisions, offers and the Top 50 follow the new policy.
      </p>
      <div className="policy-dialog-grid">
        <section>
          <h3 className="policy-h">Lever changes</h3>
          <LeverDiff levers={changes} />
        </section>
        <section>
          <h3 className="policy-h">Outcome on companies analysed</h3>
          <OutcomeCompare current={o.current} proposed={o.proposed} baseRunId={o.base_run_id} />
        </section>
      </div>
      <label className="field">
        <span className="field-label">Note for the admin (required)</span>
        <textarea
          className="input"
          rows={3}
          maxLength={400}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why this policy, and what it means for the book"
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
