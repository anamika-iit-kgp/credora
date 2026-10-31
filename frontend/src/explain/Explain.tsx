import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { AppWindow, ArrowLeft, BookOpen, Cloud, Cpu, ExternalLink, Info, Landmark, Sparkles, X, type LucideIcon } from "lucide-react";
import { CodeBlock } from "../components/CodeBlock";
import { GLOSSARY, type Term } from "./glossary";
import { useExplain } from "./ExplainContext";

export const KIND_META: Record<Term["kind"], { label: string; icon: LucideIcon }> = {
  exasol: { label: "Exasol", icon: Cpu },
  banking: { label: "Banking", icon: Landmark },
  ai: { label: "AI", icon: Sparkles },
  aws: { label: "AWS", icon: Cloud },
  app: { label: "Credora app", icon: AppWindow },
};

/** The small information mark next to a number, label or action. Opens the term's popover. */
export function Explain({ id, label }: { id: string; label?: string }) {
  const { on, openTerm } = useExplain();
  const t = GLOSSARY[id];
  if (!on || !t) return null;
  return (
    <button
      type="button"
      className="xp-i"
      aria-label={`What is ${label ?? t.term}? Explain in Exasol terms`}
      aria-haspopup="dialog"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openTerm(id, e.currentTarget);
      }}
    >
      <Info aria-hidden="true" />
    </button>
  );
}

/** A term as a chip (page banners, related terms): opens the same popover. */
export function TermChip({ id }: { id: string }) {
  const { openTerm } = useExplain();
  const t = GLOSSARY[id];
  if (!t) return null;
  return (
    <button type="button" className={`xp-chip xp-chip-${t.kind}`} aria-haspopup="dialog" onClick={(e) => openTerm(id, e.currentTarget)}>
      {t.term}
    </button>
  );
}

/** Wraps a label so its hint sits right after it and never wraps onto its own line. */
export function WithExplain({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span className="xp-with">
      {children}
      <Explain id={id} />
    </span>
  );
}

export function TermBody({
  t,
  onRelated,
  headingId,
  headingLevel = 2,
  onMore,
}: {
  t: Term;
  onRelated?: (id: string) => void;
  headingId?: string;
  headingLevel?: 2 | 3;
  onMore?: () => void;
}) {
  const kind = KIND_META[t.kind];
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="xp-term">
      <p className={`xp-kind xp-kind-${t.kind}`}>
        <kind.icon aria-hidden="true" />
        {kind.label}
      </p>
      <H className="xp-term-title" id={headingId}>
        {t.term}
      </H>
      <p className="xp-plain">{t.plain}</p>
      {t.inExasol && (
        <div className="xp-inexa">
          <p className="xp-sub">
            <Cpu aria-hidden="true" />
            In Exasol
          </p>
          <p>{t.inExasol}</p>
        </div>
      )}
      {t.objects && t.objects.length > 0 && (
        <div className="xp-objects">
          <p className="xp-sub">Exasol objects</p>
          <ul>
            {t.objects.map((o) => (
              <li key={o}>
                <code>{o}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {t.code && (
        <figure className="xp-code">
          {t.code.lang === "text" ? (
            <pre className="xp-text" tabIndex={0}>
              {t.code.snippet}
            </pre>
          ) : (
            <CodeBlock code={t.code.snippet} lang={t.code.lang} />
          )}
          <figcaption>
            From <code>{t.code.file}</code>
          </figcaption>
        </figure>
      )}
      {(t.docs || onMore) && (
        <p className="xp-links">
          {t.docs && (
            <a href={t.docs} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />
              Exasol documentation
            </a>
          )}
          {onMore && (
            <Link to={`/glossary#${t.id}`} onClick={onMore}>
              <BookOpen aria-hidden="true" />
              More in the glossary
            </Link>
          )}
        </p>
      )}
      {t.related && t.related.some((r) => GLOSSARY[r]) && (
        <div className="xp-related">
          <p className="xp-sub">Related</p>
          <ul>
            {t.related
              .filter((r) => GLOSSARY[r])
              .map((r) => (
                <li key={r}>
                  {onRelated ? (
                    <button type="button" className={`xp-chip xp-chip-${GLOSSARY[r].kind}`} onClick={() => onRelated(r)}>
                      {GLOSSARY[r].term}
                    </button>
                  ) : (
                    <Link className={`xp-chip xp-chip-${GLOSSARY[r].kind}`} to={`/glossary#${r}`}>
                      {GLOSSARY[r].term}
                    </Link>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea';
const GAP = 8;
const MARGIN = 10;

/** The one term popover: anchored to its trigger, focus-trapped, closed with Esc or a click outside. */
export function TermPopover() {
  const { term, closeTerm } = useExplain();
  const [stack, setStack] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const hid = useId();
  const [pos, setPos] = useState<{ top: number; left: number; origin: string; sheet: boolean } | null>(null);

  useEffect(() => {
    setStack(term ? [term.id] : []);
  }, [term]);

  const anchor = term?.anchor ?? null;
  const id = stack[stack.length - 1];
  const t = id ? GLOSSARY[id] : null;

  // Place below the trigger, or above it when there is no room; a bottom sheet on narrow screens.
  useLayoutEffect(() => {
    if (!t) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw < 600 || !anchor || !anchor.isConnected) {
        setPos({ top: 0, left: 0, origin: "50% 100%", sheet: true });
        return;
      }
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const below = vh - a.bottom - GAP - MARGIN;
      const above = a.top - GAP - MARGIN;
      const down = below >= Math.min(h, 320) || below >= above;
      const top = down ? a.bottom + GAP : Math.max(MARGIN, a.top - GAP - h);
      const left = Math.min(Math.max(MARGIN, a.left + a.width / 2 - 28), vw - w - MARGIN);
      const ox = Math.min(Math.max(a.left + a.width / 2 - left, 12), w - 12);
      setPos({ top, left, origin: `${ox}px ${down ? "0" : "100%"}`, sheet: false });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [t, anchor]);

  // Focus moves into the popover; Esc closes it and returns focus to the trigger; Tab stays inside.
  useEffect(() => {
    if (!t) return;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>(".xp-pop-close");
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeTerm();
        anchor?.focus?.();
        return;
      }
      if (e.key === "Tab" && el) {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && (i <= 0 || i === -1)) {
          e.preventDefault();
          items[items.length - 1].focus();
        } else if (!e.shiftKey && i === items.length - 1) {
          e.preventDefault();
          items[0].focus();
        }
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (el?.contains(target) || anchor?.contains(target)) return;
      closeTerm();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [t, anchor, closeTerm]);

  if (!t) return null;
  const close = () => {
    closeTerm();
    anchor?.focus?.();
  };
  return createPortal(
    <>
      {pos?.sheet && <div className="xp-scrim" aria-hidden="true" />}
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={hid}
        className={`xp-pop ${pos?.sheet ? "is-sheet" : ""} ${pos ? "is-placed" : ""}`}
        style={pos && !pos.sheet ? { top: pos.top, left: pos.left, transformOrigin: pos.origin } : undefined}
      >
        <div className="xp-pop-bar">
          {stack.length > 1 ? (
            <button type="button" className="xp-pop-back" onClick={() => setStack((s) => s.slice(0, -1))}>
              <ArrowLeft aria-hidden="true" />
              {GLOSSARY[stack[stack.length - 2]]?.term ?? "Back"}
            </button>
          ) : (
            <span className="xp-pop-hint">Explain mode</span>
          )}
          <button type="button" className="xp-pop-close" aria-label="Close" onClick={close}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="xp-pop-body">
          <TermBody t={t} headingId={hid} onRelated={(r) => setStack((s) => [...s, r])} onMore={closeTerm} />
        </div>
      </div>
    </>,
    document.body,
  );
}
