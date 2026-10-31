import { useState } from "react";
import { matchPath, useLocation } from "react-router-dom";
import { ChevronDown, Cpu } from "lucide-react";
import { PAGE_EXPLAIN } from "./pages";
import { useExplain } from "./ExplainContext";
import { TermChip } from "./Explain";

const KEYS = Object.keys(PAGE_EXPLAIN);

export function pageExplainFor(pathname: string) {
  const key = KEYS.find((k) => matchPath({ path: k, end: true }, pathname));
  return key ? PAGE_EXPLAIN[key] : null;
}

/** "What Exasol is doing on this screen": a slim band under the page header (Explain mode only). */
export function PageExplain() {
  const { on, exasolUser } = useExplain();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const p = pageExplainFor(pathname);
  if (!on || !p) return null;
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
