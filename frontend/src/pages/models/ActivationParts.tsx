// Risk-model activation maker-checker: the data scientist requests, the admin approves or rejects.
// Shared by the Risk models page (request, my requests) and the admin's Approvals screen.
import { useState } from "react";
import { Ban, FileCheck, Power, ShieldCheck, TriangleAlert } from "lucide-react";
import { useActivationRequests, useDecideActivation, useRequestActivation } from "../../api/workflow";
import type { ActivationRequest, Model, ModelMetricsCard } from "../../api/types";
import { useUser } from "../../auth/AuthContext";
import { Dialog, Empty, ErrorState, Loading, Panel } from "../../components/ui";
import { dateTime } from "../../lib/format";
import { ProposalStatus } from "./PolicyParts";
import { Explain } from "../../explain/Explain";

const CHANGED = "Active model changed since this request. Send a new activation request.";
const f3 = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(3));

/** Data scientist: "Request activation" for an inactive model. Pending requests show instead of the button. */
export function RequestActivationButton({ model, label }: { model: Pick<Model, "version" | "active">; label?: string }) {
  const reqs = useActivationRequests();
  const [open, setOpen] = useState(false);
  if (model.active) return null;
  const pending = (reqs.data ?? []).find((r) => r.model_version === model.version && r.status === "PENDING");
  if (pending)
    return (
      <span className="small muted" title={`Request #${pending.request_id} waits for the admin`}>
        <ProposalStatus s="PENDING" /> activation requested
      </span>
    );
  return (
    <>
      <button className="btn btn-quiet btn-sm" onClick={() => setOpen(true)}>
        <Power aria-hidden="true" />
        {label ?? "Request activation"}
      </button>
      <Explain id="model-activation" label="Request activation" />
      <RequestDialog version={open ? model.version : null} onClose={() => setOpen(false)} />
    </>
  );
}

function RequestDialog({ version, onClose }: { version: string | null; onClose: () => void }) {
  const [note, setNote] = useState("");
  const m = useRequestActivation();
  if (!version) return null;
  const done = () => {
    m.reset();
    setNote("");
    onClose();
  };
  return (
    <Dialog
      open={!!version}
      onClose={done}
      title={`Request activation of ${version}`}
      footer={
        <>
          <button className="btn btn-quiet" onClick={done}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!note.trim() || m.isPending} onClick={() => m.mutate({ version, note: note.trim() }, { onSuccess: done })}>
            <Power aria-hidden="true" />
            {m.isPending ? "Sending…" : "Send to the admin"}
          </button>
        </>
      }
    >
      <p className="small muted">
        The admin approves or rejects the request. Only an approval switches <code>CREDORA.MODEL_REGISTRY.IS_ACTIVE</code> (written as{" "}
        <code>CREDORA_SVC</code>). The next analysis run then scores with {version}.
      </p>
      <label className="field">
        <span className="field-label">Note for the admin (required)</span>
        <textarea className="input" rows={3} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this model? Hold-out AUC, stability, what changes" autoFocus />
      </label>
      {m.isError && (
        <p className="form-error" role="alert">
          {(m.error as Error).message}
        </p>
      )}
    </Dialog>
  );
}

function MetricsTable({ cand, cur }: { cand: ModelMetricsCard | null; cur: ModelMetricsCard | null }) {
  return (
    <table className="table policy-table">
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col" className="r">AUC</th>
          <th scope="col" className="r">Gini</th>
        </tr>
      </thead>
      <tbody>
        {cur && (
          <tr>
            <td>
              <code>{cur.version}</code> <span className="small muted">active now · {cur.algorithm}</span>
            </td>
            <td className="r num">{f3(cur.auc)}</td>
            <td className="r num">{f3(cur.gini)}</td>
          </tr>
        )}
        {cand && (
          <tr>
            <td>
              <code>{cand.version}</code> <span className="small muted">requested · {cand.algorithm}</span>
            </td>
            <td className="r num strong">{f3(cand.auc)}</td>
            <td className="r num strong">{f3(cand.gini)}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Decision({ r }: { r: ActivationRequest }) {
  return (
    <span className="small">
      {r.status === "APPROVED" ? "Approved" : "Rejected"} by <code>{r.decided_by}</code>, {dateTime(r.decided_at)}
      {r.decision_note && <>, with the note “{r.decision_note}”</>}
    </span>
  );
}

/** Data scientist: their requests and what the admin decided. */
export function MyActivationRequests() {
  const q = useActivationRequests();
  if (!q.data?.length) return null;
  return (
    <Panel title="My activation requests" icon={FileCheck} flush aside={<span className="small muted">The admin approves or rejects each one</span>}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Request</th>
              <th scope="col">Sent</th>
              <th scope="col">Model</th>
              <th scope="col">Status</th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.request_id}>
                <td className="strong">#{r.request_id}</td>
                <td className="nowrap">{dateTime(r.created_at)}</td>
                <td>
                  <code>{r.model_version}</code> <span className="small muted">replacing {r.current_version ?? "none"}</span>
                </td>
                <td>
                  <ProposalStatus s={r.status} />
                </td>
                <td>
                  {r.status === "PENDING" ? (
                    <span className="small muted">{r.baseline_changed ? "Another model became active, so it cannot be approved." : "Waiting for the admin"}</span>
                  ) : (
                    <Decision r={r} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** Admin: activation requests on the Approvals screen. */
export function ActivationSection({ tab }: { tab: "pending" | "decided" }) {
  const q = useActivationRequests();
  const me = useUser();
  const [act, setAct] = useState<{ r: ActivationRequest; a: "approve" | "reject" } | null>(null);
  const rows = (q.data ?? []).filter((r) => (tab === "pending" ? r.status === "PENDING" : r.status !== "PENDING"));
  return (
    <>
      <p className="muted section-lede">
        The data scientist trains models and requests activation of one. Approving switches <code>CREDORA.MODEL_REGISTRY.IS_ACTIVE</code>{" "}
        as <code>CREDORA_SVC</code>. The next analysis run scores with that model. Training never activates a model by itself.
      </p>
      {q.isLoading && <Loading rows={3} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && (
        <Panel>
          <Empty title={tab === "pending" ? "No activation requests" : "No decisions yet"} icon={Power}>
            {tab === "pending" ? "Requests from the data scientist to activate a risk model appear here." : "Approved and rejected requests stay here, read-only."}
          </Empty>
        </Panel>
      )}
      {rows.map((r) => {
        const own = r.created_by === me.username;
        return (
          <Panel
            key={r.request_id}
            className="proposal"
            icon={Power}
            title={
              <>
                Request #{r.request_id} <span className="muted">to activate</span> <code>{r.model_version}</code>
              </>
            }
            aside={
              <span className="proposal-meta">
                <ProposalStatus s={r.status} />
                <span className="small muted">
                  by <code>{r.created_by}</code>, {dateTime(r.created_at)}
                </span>
              </span>
            }
          >
            <MetricsTable cand={r.metrics.candidate} cur={r.metrics.current} />
            <blockquote className="proposal-note">
              <span className="field-label">Note from {r.created_by}</span>
              <p>{r.note}</p>
            </blockquote>
            {r.status === "PENDING" ? (
              <>
                {r.baseline_changed && (
                  <p className="callout callout-refer" role="status">
                    <TriangleAlert aria-hidden="true" />
                    {CHANGED}
                  </p>
                )}
                <div className="btn-row">
                  <button className="btn btn-primary" disabled={own || r.baseline_changed} onClick={() => setAct({ r, a: "approve" })}>
                    <ShieldCheck aria-hidden="true" />
                    Approve and activate
                  </button>
                  <Explain id="model-activation-approval" label="Approve and activate" />
                  <button className="btn btn-danger-quiet" disabled={own} onClick={() => setAct({ r, a: "reject" })}>
                    <Ban aria-hidden="true" />
                    Reject
                  </button>
                  {own && <span className="small muted">You made this request, so another person decides.</span>}
                </div>
              </>
            ) : (
              <p className="proposal-decision">
                <Decision r={r} />
              </p>
            )}
          </Panel>
        );
      })}
      <DecideActivation target={act} onClose={() => setAct(null)} />
    </>
  );
}

function DecideActivation({ target, onClose }: { target: { r: ActivationRequest; a: "approve" | "reject" } | null; onClose: () => void }) {
  const [note, setNote] = useState("");
  const m = useDecideActivation();
  if (!target) return null;
  const { r, a } = target;
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
      title={a === "approve" ? `Activate ${r.model_version}?` : `Reject the request to activate ${r.model_version}?`}
      footer={
        <>
          <button className="btn btn-quiet" onClick={done}>
            Cancel
          </button>
          <button
            className={`btn ${a === "reject" ? "btn-danger" : "btn-primary"}`}
            disabled={!note.trim() || m.isPending}
            onClick={() => m.mutate({ id: r.request_id, action: a, note: note.trim() }, { onSuccess: done })}
          >
            {m.isPending ? "Saving…" : a === "approve" ? "Approve and activate" : "Reject"}
          </button>
        </>
      }
    >
      <p>
        {a === "approve"
          ? `${r.model_version} becomes the active model in CREDORA.MODEL_REGISTRY, and ${r.current_version ?? "no model"} is deactivated. Past runs are not rescored.`
          : "The request is closed and stays read-only. The data scientist sees your note."}
      </p>
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
