// Loan operations: "New results published" when the data scientist hands over a new run.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Megaphone, X } from "lucide-react";
import { useRuns } from "../api/hooks";
import type { Run } from "../api/types";
import { useUser } from "../auth/AuthContext";
import { dateTime } from "../lib/format";

const KEY = "credora.seen-published-run";
const EVENT = "credora:seen-run";

function seen(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The newest published run, and whether loan operations has not acknowledged it yet. */
export function useNewPublished(): { run: Run | null; isNew: boolean; markSeen: () => void } {
  const user = useUser();
  const on = user.role === "loanops";
  const runs = useRuns(on);
  const [last, setLast] = useState(seen);
  useEffect(() => {
    const f = () => setLast(seen());
    window.addEventListener(EVENT, f);
    return () => window.removeEventListener(EVENT, f);
  }, []);
  const run =
    (runs.data ?? [])
      .filter((r) => r.published)
      .sort((a, b) => (b.published_at ?? b.finished_at ?? "").localeCompare(a.published_at ?? a.finished_at ?? ""))[0] ?? null;
  const markSeen = () => {
    if (!run) return;
    try {
      localStorage.setItem(KEY, run.run_id);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event(EVENT));
  };
  return { run, isNew: on && !!run && last !== run.run_id, markSeen };
}

export function PublishedNotice() {
  const { run, isNew, markSeen } = useNewPublished();
  if (!isNew || !run) return null;
  return (
    <div className="callout callout-approve published-notice" role="status">
      <Megaphone aria-hidden="true" />
      <div>
        <p className="strong">New results published</p>
        <p className="small">
          Run <code>{run.run_id}</code> was published by <code>{run.published_by ?? "the data scientist"}</code>
          {run.published_at ? <>, {dateTime(run.published_at)}</> : null}
          {run.publish_note ? <>, with the note “{run.publish_note}”.</> : "."} Decisions and the Top 50 now show it. Assign its companies to
          relationship managers from there.
        </p>
        <p className="small">
          <Link to="/analysis/decisions?assigned=no" onClick={markSeen}>
            Unassigned companies
          </Link>{" "}
          · <Link to="/analysis/top50" onClick={markSeen}>Top 50</Link>
        </p>
      </div>
      <button className="btn btn-quiet btn-sm" onClick={markSeen} aria-label="Dismiss">
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
