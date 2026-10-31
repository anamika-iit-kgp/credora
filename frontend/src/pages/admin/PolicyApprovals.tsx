import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, FileCheck, Gavel, ShieldCheck, TriangleAlert, Workflow, X } from "lucide-react";
import { useDecideProposal, useProposals } from "../../api/policy";
import type { ApproveResult, PolicyProposal } from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { JobProgress } from "../../components/JobProgress";
import { Dialog, Empty, ErrorState, Loading, Panel } from "../../components/ui";
import { dateTime } from "../../lib/format";
import { usePersistentJob } from "../../lib/usePersistentJob";
import { LeverDiff, OutcomeCompare, ProposalStatus } from "../models/PolicyParts";
import { Explain } from "../../explain/Explain";

export type Tab = "pending" | "decided";
type Act = "approve" | "reject";

const CHANGED = "Policy changed since this proposal. Start a new what-if run.";

/** Policy proposals on the admin's Approvals screen (pages/admin/Approvals.tsx). */
export function PolicyProposalsSection({ tab, onApproved }: { tab: Tab; onApproved?: () => void }) {
  const q = useProposals();
  const qc = useQueryClient();
  const [act, setAct] = useState<{ p: PolicyProposal; a: Act } | null>(null);
  const [jobId, setJobId] = usePersistentJob("policy");
  const all = q.data ?? [];
  const pending = all.filter((p) => p.status === "PENDING");
  const decided = all.filter((p) => p.status !== "PENDING");
  const rows = tab === "pending" ? pending : decided;

  return (
    <>
      <p className="muted section-lede">
        The data scientist proposes policy changes from saved what-if runs. Approving one writes the levers to <code>CREDORA.CONFIG</code>{" "}
        as <code>CREDORA_SVC</code> and runs the full analysis, which is published at once, so decisions, pre-approved offers, the Top 50
        and the semantic layer follow the new policy. Under maker-checker, nobody decides on their own proposal.
      </p>
      {jobId && (
        <Panel
          title="Applying the approved policy"
          icon={Workflow}
          aside={
            <button className="btn btn-quiet btn-sm" onClick={() => setJobId(null)}>
              <X aria-hidden="true" />
              Clear
            </button>
          }
        >
          <JobProgress
            jobId={jobId}
            title="CREDORA.CONFIG, then CREDORA.RUN_ANALYSIS()"
            onFinish={() => {
              void qc.invalidateQueries();
            }}
          />
        </Panel>
      )}
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && (
        <Panel>
          <Empty title={tab === "pending" ? "Nothing to approve" : "No decisions yet"} icon={Gavel}>
            {tab === "pending" ? "Policy proposals from the data scientist will appear here." : "Approved and rejected proposals are kept here, read-only."}
          </Empty>
        </Panel>
      )}
      {rows.map((p) => (
        <ProposalCard key={p.proposal_id} p={p} onAct={(a) => setAct({ p, a })} />
      ))}
      <DecideDialog
        target={act}
        onClose={() => setAct(null)}
        onApproved={(r) => {
          setJobId(r.job_id);
          onApproved?.();
        }}
      />
    </>
  );
}

function ProposalCard({ p, onAct }: { p: PolicyProposal; onAct: (a: Act) => void }) {
  const me = useUser();
  const own = p.created_by === me.username;
  return (
    <Panel
      className="proposal"
      title={
        <>
          Proposal #{p.proposal_id} <span className="muted">from what-if run</span> <code>{p.run_id}</code>
        </>
      }
      icon={FileCheck}
      aside={
        <span className="proposal-meta">
          <ProposalStatus s={p.status} />
          <span className="small muted">
            by <code>{p.created_by}</code>, {dateTime(p.created_at)}
          </span>
        </span>
      }
    >
      <div className="grid-2 proposal-grid">
        <section>
          <h3 className="policy-h">Lever changes</h3>
          <LeverDiff levers={p.levers} />
        </section>
        <section>
          <h3 className="policy-h">Outcome on companies analysed</h3>
          <OutcomeCompare current={p.outcome.current} proposed={p.outcome.proposed} baseRunId={p.outcome.base_run_id} />
        </section>
      </div>
      <blockquote className="proposal-note">
        <span className="field-label">Note from {p.created_by}</span>
        <p>{p.note}</p>
      </blockquote>
      {p.status === "PENDING" ? (
        <>
          {p.baseline_changed && (
            <p className="callout callout-refer" role="status">
              <TriangleAlert aria-hidden="true" />
              {CHANGED}
            </p>
          )}
          <div className="btn-row">
            <button
              className="btn btn-primary"
              disabled={own || p.baseline_changed}
              title={own ? "You cannot approve your own proposal." : undefined}
              onClick={() => onAct("approve")}
            >
              <ShieldCheck aria-hidden="true" />
              Approve and apply
            </button>
            <Explain id="policy-config" label="Approve and apply" />
            <button className="btn btn-danger-quiet" disabled={own} onClick={() => onAct("reject")}>
              <Ban aria-hidden="true" />
              Reject
            </button>
            {own && <span className="small muted">You made this proposal, so another person decides.</span>}
          </div>
        </>
      ) : (
        <p className="small proposal-decision">
          {p.status === "APPROVED" ? "Approved" : "Rejected"} by <code>{p.decided_by}</code>, {dateTime(p.decided_at)}
          {p.decision_note && <>, with the note “{p.decision_note}”</>}
          {p.applied_run_id && (
            <>
              {" "}
              · applied by analysis run <code>{p.applied_run_id}</code>
            </>
          )}
        </p>
      )}
    </Panel>
  );
}

function DecideDialog({
  target,
  onClose,
  onApproved,
}: {
  target: { p: PolicyProposal; a: Act } | null;
  onClose: () => void;
  onApproved: (r: ApproveResult) => void;
}) {
  const [note, setNote] = useState("");
  const m = useDecideProposal();
  if (!target) return null;
  const { p, a } = target;
  const done = () => {
    m.reset();
    setNote("");
    onClose();
  };
  return (
    <Dialog
      open={!!target}
      onClose={done}
      tone={a === "reject" ? "danger" : "default"}
      title={a === "approve" ? `Approve proposal #${p.proposal_id} and apply it?` : `Reject proposal #${p.proposal_id}?`}
      footer={
        <>
          <button className="btn btn-quiet" onClick={done}>
            Cancel
          </button>
          <button
            className={`btn ${a === "reject" ? "btn-danger" : "btn-primary"}`}
            disabled={!note.trim() || m.isPending}
            onClick={() =>
              m.mutate(
                { id: p.proposal_id, action: a, note: note.trim() },
                {
                  onSuccess: (r) => {
                    if (a === "approve") onApproved(r as ApproveResult);
                    done();
                  },
                },
              )
            }
          >
            {m.isPending ? "Saving…" : a === "approve" ? "Approve and apply" : "Reject"}
          </button>
        </>
      }
    >
      {a === "approve" ? (
        <p>
          One job writes these values to <code>CREDORA.CONFIG</code> and then runs <code>CREDORA.RUN_ANALYSIS()</code> on the bank&apos;s
          data. Because you approved it, the run is published at once (by the system on your behalf) and replaces the current
          decisions and pre-approved offers. Offers already in negotiation keep their terms.
        </p>
      ) : (
        <p>The proposal is closed and stays read-only. The data scientist sees your note.</p>
      )}
      <LeverDiff levers={p.levers} />
      <label className="field">
        <span className="field-label">Decision note (required)</span>
        <textarea className="input" rows={3} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </label>
      {m.isError && (
        <p className="form-error" role="alert">
          {(m.error as Error).message}
        </p>
      )}
    </Dialog>
  );
}
