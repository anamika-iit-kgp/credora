import { useEffect, useState } from "react";
import { matchPath, useLocation } from "react-router-dom";
import { ChevronDown, Cpu, X } from "lucide-react";
import { PAGE_EXPLAIN } from "./pages";
import { useExplain } from "./ExplainContext";
import { TermChip } from "./Explain";

const KEYS = Object.keys(PAGE_EXPLAIN);
const SEEN_PREFIX = "credora.band.seen.";

function pageKeyFor(pathname: string) {
  return KEYS.find((k) => matchPath({ path: k, end: true }, pathname)) ?? null;
}

export function pageExplainFor(pathname: string) {
  const key = pageKeyFor(pathname);
  return key ? PAGE_EXPLAIN[key] : null;
}

function seen(key: string) {
  try {
    return sessionStorage.getItem(SEEN_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

function markSeen(key: string) {
  try {
    sessionStorage.setItem(SEEN_PREFIX + key, "1");
  } catch {
    /* storage unavailable, so the band shows again on the next visit */
  }
}

// The screen being visited now, tracked outside React so a header that remounts while its data loads keeps its band
// instead of counting the remount as a second visit.
let liveKey: string | null = null;

/** The band shows once per screen per browser session. Screens that differ only by a route parameter count as one. */
function visitShows(key: string | null) {
  if (!key) {
    liveKey = null;
    return false;
  }
  if (liveKey === key) return true;
  if (seen(key)) return false;
  liveKey = key;
  return true;
}

/** "What Exasol is doing on this screen": a slim band under the page header (Explain mode only). */
export function PageExplain() {
  const { on, exasolUser } = useExplain();
  const { pathname } = useLocation();
  const key = pageKeyFor(pathname);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(() => visitShows(key));

  useEffect(() => {
    setShown(visitShows(key));
    setOpen(false);
  }, [key]);

  // Counts as seen only once it is on screen, so a visit with Explain mode off does not use up the one showing.
  useEffect(() => {
    if (on && shown && key) markSeen(key);
  }, [on, shown, key]);

  const p = key ? PAGE_EXPLAIN[key] : null;
  if (!on || !p || !shown) return null;

  const dismiss = () => {
    if (key) markSeen(key);
    liveKey = null;
    setShown(false);
  };

  return (
    <section className="xp-band" aria-label="What Exasol is doing on this screen">
      <div className="xp-band-row">
        <span className="xp-band-mark" aria-hidden="true">
          <Cpu />
        </span>
        <p className="xp-band-text">
          <span className="xp-band-label">What Exasol is doing here</span>
          {p.headline}
        </p>
        {p.exasol.length > 0 && (
          <button type="button" className="xp-band-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Less" : "How"}
            <ChevronDown aria-hidden="true" />
          </button>
        )}
        <button type="button" className="xp-toast-x" aria-label="Dismiss" onClick={dismiss}>
          <X aria-hidden="true" />
        </button>
      </div>
      {open && (
        <ul className="xp-band-list">
          {p.exasol.map((s) => (
            <li key={s}>{s}</li>
          ))}
          {exasolUser && (
            <li>
              Your reads on this screen run as <code>{exasolUser}</code>.
            </li>
          )}
        </ul>
      )}
      {p.terms.length > 0 && (
        <ul className="xp-band-terms" aria-label="Terms on this screen">
          {p.terms.map((t) => (
            <li key={t}>
              <TermChip id={t} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
