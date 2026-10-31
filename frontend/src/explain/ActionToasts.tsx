import { useEffect, useRef, useState } from "react";
import { Cpu, SquareTerminal, X } from "lucide-react";
import { ACTION_EXPLAIN } from "./actions";
import { useExplain, type ActionToast } from "./ExplainContext";

const SHOWN_STEPS = 3;
const LIFETIME_MS = 22_000;

function Toast({ t }: { t: ActionToast }) {
  const { dismissToast, setConsoleOpen, consoleOpen } = useExplain();
  const a = ACTION_EXPLAIN[t.action];
  const [all, setAll] = useState(false);
  const [held, setHeld] = useState(false);
  const left = useRef(LIFETIME_MS);

  // Leaves on its own unless the reader is holding it (hover, focus or expanded steps).
  useEffect(() => {
    if (held || all) return;
    const start = Date.now();
    const id = window.setTimeout(() => dismissToast(t.key), left.current);
    return () => {
      window.clearTimeout(id);
      left.current = Math.max(4000, left.current - (Date.now() - start));
    };
  }, [held, all, dismissToast, t.key]);

  if (!a) return null;
  const steps = all ? a.steps : a.steps.slice(0, SHOWN_STEPS);
  return (
    <li
      className="xp-toast"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div className="xp-toast-head">
        <span className="xp-toast-mark" aria-hidden="true">
          <Cpu />
        </span>
        <div className="xp-toast-title">
          <p className="xp-toast-kicker">In Exasol now</p>
          <p className="xp-toast-name">{a.title}</p>
        </div>
        <button type="button" className="xp-toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.key)}>
          <X aria-hidden="true" />
        </button>
      </div>
      <p className="xp-toast-as">
        Runs as <span>{a.runsAs}</span>
      </p>
      <ol className="xp-toast-steps">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <div className="xp-toast-foot">
        {a.steps.length > SHOWN_STEPS && (
          <button type="button" className="xp-link-btn" aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? "Fewer steps" : `All ${a.steps.length} steps`}
          </button>
        )}
        {!consoleOpen && (
          <button type="button" className="xp-link-btn" onClick={() => setConsoleOpen(true)}>
            <SquareTerminal aria-hidden="true" />
            Watch it in the Exasol console
          </button>
        )}
      </div>
      {all && a.objects.length > 0 && (
        <ul className="xp-toast-objects" aria-label="Exasol objects">
          {a.objects.map((o) => (
            <li key={o}>
              <code>{o}</code>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Action explanations, bottom right; announced politely to screen readers. */
export function ActionToasts() {
  const { toasts } = useExplain();
  return (
    <ol className="xp-toasts" aria-live="polite" aria-label="What Exasol is doing">
      {toasts.map((t) => (
        <Toast key={t.key} t={t} />
      ))}
    </ol>
  );
}
