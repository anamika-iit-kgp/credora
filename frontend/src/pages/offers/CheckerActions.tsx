import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useOfferAction } from "../../api/hooks";
import type { Offer } from "../../api/types";
import { Dialog, Panel } from "../../components/ui";
import { Explain } from "../../explain/Explain";

type Act = "verify" | "sanction" | "reject";
const WORD: Record<Act, { verb: string; done: string; help: string }> = {
  verify: { verb: "Verify", done: "Verified", help: "Confirms the terms, KYC and documents. A second person sanctions." },
  sanction: { verb: "Sanction", done: "Sanctioned", help: "Final approval. Must be a different person from the one who verified." },
  reject: { verb: "Reject", done: "Rejected", help: "Ends the offer. The customer is told by their RM." },
};

export function allowedActions(o: Offer): Act[] {
  if (o.stage === "NEGOTIATING" || o.stage === "ESCALATED") return ["verify", "reject"];
  if (o.stage === "VERIFIED") return ["sanction", "reject"];
  if (o.stage === "OFFERED") return ["reject"];
  return [];
}

export function CheckerDialog({ offer, act, onClose }: { offer: Offer; act: Act | null; onClose: () => void }) {
  const [note, setNote] = useState("");
  const m = useOfferAction(offer.offer_id);
  if (!act) return null;
  const w = WORD[act];
  return (
    <Dialog
      open={!!act}
      onClose={() => {
        m.reset();
        setNote("");
        onClose();
      }}
      tone={act === "reject" ? "danger" : "default"}
      title={`${w.verb} offer ${offer.offer_id}?`}
      footer={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${act === "reject" ? "btn-danger" : "btn-primary"}`}
            disabled={!note.trim() || m.isPending}
            onClick={() =>
              m.mutate(
                { action: act, body: { note: note.trim() } },
                {
                  onSuccess: () => {
                    setNote("");
                    onClose();
                  },
                },
              )
            }
          >
            {m.isPending ? "Saving…" : w.verb}
          </button>
        </>
      }
    >
      <p>
        <strong>{offer.legal_name}</strong>. {w.help}
      </p>
      <label className="field">
        <span className="field-label">Note (required)</span>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </label>
      {m.isError && (
        <p className="form-error" role="alert">
          {(m.error as Error).message}
        </p>
      )}
    </Dialog>
  );
}

export function CheckerActions({ offer }: { offer: Offer }) {
  const [act, setAct] = useState<Act | null>(null);
  const acts = allowedActions(offer);
  return (
    <Panel title="Checker decision" icon={ShieldCheck} aside={<span className="small muted">Maker-checker. The RM proposes, loan operations verifies and a second checker sanctions.</span>}>
      {acts.length === 0 ? (
        <p className="muted">No action is open at stage {offer.stage.toLowerCase()}.</p>
      ) : (
        <div className="btn-row">
          {acts.map((a) => (
            <button key={a} className={`btn ${a === "reject" ? "btn-danger-quiet" : "btn-primary"}`} onClick={() => setAct(a)}>
              {WORD[a].verb}
            </button>
          ))}
          <Explain id="maker-checker" label="Verify and sanction" />
        </div>
      )}
      <CheckerDialog offer={offer} act={act} onClose={() => setAct(null)} />
    </Panel>
  );
}
