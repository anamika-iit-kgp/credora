// Loan operations assigns companies of the published run to relationship managers (CREDORA.RM_ASSIGNMENT).
import { useState } from "react";
import { UserPlus } from "lucide-react";
import { useAssign, useRms } from "../api/workflow";
import type { AssignResult } from "../api/types";
import { num } from "../lib/format";
import { Dialog } from "./ui";
import { Explain } from "../explain/Explain";

/** Who works the company now; "Not assigned" when nobody does. */
export function AssignedRm({ rmId }: { rmId: string | null | undefined }) {
  return rmId ? <code>{rmId}</code> : <span className="small muted">Not assigned</span>;
}

/** Selection toolbar above a list: "n selected · Assign to RM". */
export function AssignBar({ count, onAssign, onClear }: { count: number; onAssign: () => void; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div className="assign-bar" role="region" aria-label="Selected companies">
      <span className="strong num">{num(count)}</span> selected
      <button className="btn btn-primary btn-sm" onClick={onAssign}>
        <UserPlus aria-hidden="true" />
        Assign to RM
      </button>
      <Explain id="rm-assignment" label="Assign to RM" />
      <button className="btn btn-quiet btn-sm" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}

export function AssignDialog({
  cifs,
  onClose,
  onDone,
}: {
  cifs: string[] | null;
  onClose: () => void;
  onDone?: (r: AssignResult) => void;
}) {
  const rms = useRms(!!cifs);
  const m = useAssign();
  const [rm, setRm] = useState("");
  if (!cifs) return null;
  const done = () => {
    m.reset();
    setRm("");
    onClose();
  };
  return (
    <Dialog
      open={!!cifs}
      onClose={done}
      title={cifs.length === 1 ? `Assign ${cifs[0]} to a relationship manager` : `Assign ${num(cifs.length)} companies to a relationship manager`}
      footer={
        <>
          <button className="btn btn-quiet" onClick={done}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!rm || m.isPending}
            onClick={() =>
              m.mutate(
                { cif_ids: cifs, rm_id: rm },
                {
                  onSuccess: (r) => {
                    onDone?.(r);
                    done();
                  },
                },
              )
            }
          >
            <UserPlus aria-hidden="true" />
            {m.isPending ? "Assigning…" : "Assign"}
          </button>
        </>
      }
    >
      <p className="small muted">
        The assignment is written to <code>CREDORA.RM_ASSIGNMENT</code> in Exasol. From then on the manager&apos;s own Exasol user reads
        these companies, at full detail, through row-filtered views. Companies already assigned move to the new manager.
      </p>
      <fieldset className="rm-pick">
        <legend className="field-label">Relationship manager (customer master)</legend>
        {rms.isLoading && <p className="muted small">Loading managers…</p>}
        {rms.data?.map((r) => (
          <label key={r.rm_id} className={`rm-opt ${rm === r.rm_id ? "is-on" : ""}`}>
            <input type="radio" name="rm" value={r.rm_id} checked={rm === r.rm_id} onChange={() => setRm(r.rm_id)} />
            <span>
              <span className="strong">{r.name}</span> <code className="small">{r.rm_id}</code>
              <br />
              <span className="small muted">
                {r.branch} · {num(r.assigned)} assigned
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {m.isError && (
        <p className="form-error" role="alert">
          {(m.error as Error).message}
        </p>
      )}
    </Dialog>
  );
}

/** Checkbox cell for a selectable row. */
export function SelectCell({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <td className="sel">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </td>
  );
}
