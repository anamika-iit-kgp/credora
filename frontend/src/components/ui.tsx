import { useEffect, useId, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, CircleX, Clock3, Inbox, RotateCcw, type LucideIcon } from "lucide-react";
import type { Decision, DecisionMix } from "../api/types";
import { ApiError } from "../api/client";
import { num, rupees, rupeesShort } from "../lib/format";
import { PageExplain } from "../explain/PageExplain";
import { useExplain } from "../explain/ExplainContext";
import { Refused } from "./Refused";

export function PageHeader({
  title,
  lede,
  actions,
  crumbs,
  children,
}: {
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  crumbs?: { to?: string; label: string }[];
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      {crumbs && (
        <nav aria-label="Breadcrumb" className="crumbs">
          <ol>
            {crumbs.map((c, i) => (
              <li key={i}>{c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}</li>
            ))}
          </ol>
        </nav>
      )}
      <div className="page-head-row">
        <div className="page-head-text">
          <h1 className="page-title">{title}</h1>
          {lede && <p className="page-lede">{lede}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {children}
      <PageExplain />
    </header>
  );
}

export function Panel({
  title,
  aside,
  children,
  className = "",
  flush = false,
  id,
  icon: Icon,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
  id?: string;
  icon?: LucideIcon;
}) {
  const hid = useId();
  return (
    <section className={`panel ${flush ? "panel-flush" : ""} ${className}`} aria-labelledby={title ? hid : undefined} id={id}>
      {(title || aside) && (
        <div className="panel-head">
          {title && (
            <h2 className="panel-title" id={hid}>
              {Icon && <Icon aria-hidden="true" />}
              {title}
            </h2>
          )}
          {aside && <div className="panel-aside">{aside}</div>}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

const DECISION_WORD: Record<Decision, string> = { APPROVE: "Approve", REFER: "Refer", DECLINE: "Decline" };
const DECISION_ICON: Record<Decision, LucideIcon> = { APPROVE: CircleCheck, REFER: Clock3, DECLINE: CircleX };

/** Decision mark: a distinct icon shape, a colour and the word, so it never relies on colour alone. */
export function DecisionBadge({ d, large = false }: { d: Decision | null | undefined; large?: boolean }) {
  if (!d) return <span className="muted">Not analysed</span>;
  const Icon = DECISION_ICON[d];
  return (
    <span className={`dec dec-${d.toLowerCase()} ${large ? "dec-lg" : ""}`}>
      <Icon className="dec-ic" aria-hidden="true" />
      {DECISION_WORD[d]}
    </span>
  );
}

export function Grade({ g }: { g: string | null | undefined }) {
  if (!g) return <span className="muted">–</span>;
  const band = g[0];
  return <span className={`grade grade-${band.toLowerCase()}`}>{g}</span>;
}

export function Money({ v, short = false }: { v: number | null | undefined; short?: boolean }) {
  return (
    <span className="num" title={short && v != null ? rupees(v) : undefined}>
      {short ? rupeesShort(v) : rupees(v)}
    </span>
  );
}

export function Stage({ s }: { s: string | null | undefined }) {
  if (!s) return <span className="muted">–</span>;
  const label = s.charAt(0) + s.slice(1).toLowerCase();
  return <span className={`stage stage-${s.toLowerCase()}`}>{label}</span>;
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Ease-out curve for the count-up, close to the cubic bezier the page transitions use. */
function easeOut(t: number) {
  return 1 - Math.pow(1 - t, 4);
}

/**
 * A figure that counts up to its value the first time it appears, then updates in place.
 * The final text is rendered on the server-free first paint, so nothing reads as missing if script is slow.
 */
export function Counter({ value, format = num, className = "" }: { value: number; format?: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current ?? 0;
    shown.current = value;
    if (reducedMotion() || from === value) {
      el.textContent = format(value);
      return;
    }
    const decimals = Number.isInteger(value) ? 0 : 2;
    const ms = from === 0 ? 900 : 400;
    const t0 = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const v = from + (value - from) * easeOut(t);
      el.textContent = format(decimals ? Math.round(v * 100) / 100 : Math.round(v));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, format]);
  return (
    <span ref={ref} className={`num ${className}`}>
      {format(value)}
    </span>
  );
}

export function MixBar({ mix, label }: { mix: DecisionMix; label?: string }) {
  const total = mix.APPROVE + mix.REFER + mix.DECLINE || 1;
  const segs: [Decision, number][] = [
    ["APPROVE", mix.APPROVE],
    ["REFER", mix.REFER],
    ["DECLINE", mix.DECLINE],
  ];
  return (
    <div className="mix">
      <div
        className="mix-bar"
        role="img"
        aria-label={`${label ? label + ": " : ""}${mix.APPROVE} approve, ${mix.REFER} refer, ${mix.DECLINE} decline`}
      >
        {segs.map(([d, n]) => (
          <span key={d} className={`mix-seg mix-${d.toLowerCase()}`} style={{ flexGrow: n / total }} />
        ))}
      </div>
      <dl className="mix-legend">
        {segs.map(([d, n]) => (
          <div key={d}>
            <dt>
              <DecisionBadge d={d} />
            </dt>
            <dd>
              <Counter value={n} />
              <span className="muted"> {Math.round((n / total) * 100)}%</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Loading({ label = "Loading", rows = 6 }: { label?: string; rows?: number }) {
  return (
    <div className="loading" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ width: `${92 - ((i * 17) % 35)}%` }} />
      ))}
    </div>
  );
}

/**
 * The 403 the API sends when Exasol itself refused a statement. It starts with "Exasol denied access for your role",
 * then carries Exasol's own message, and the refused SQL on later lines when the API passes it along.
 */
function exasolRefusal(message: string | undefined): { message: string; sql?: string } | null {
  if (!message) return null;
  const m = /^Exasol denied access[^:]*:\s*([\s\S]+)$/i.exec(message);
  const text = m ? m[1] : /insufficient privileges/i.test(message) ? message : null;
  if (!text) return null;
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const rest = lines.slice(1).join("\n");
  const sql = /^(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|EXECUTE|CREATE|ALTER|DROP|GRANT|IMPORT|EXPORT)\b/i.test(rest) ? rest : undefined;
  return { message: lines[0] ?? text, sql };
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const { exasolUser } = useExplain();
  const e = error as ApiError | Error | undefined;
  const status = (e as ApiError)?.status;
  const refusal = status === 403 ? exasolRefusal(e?.message) : null;
  const notAssigned = status === 403 && /not assigned to you/i.test(e?.message ?? "");
  const myBook = notAssigned || (refusal !== null && exasolUser === "CREDORA_RM");
  const title =
    status === 403
      ? "Your role cannot open this"
      : status === 404
        ? "Not found"
        : status === 0
          ? "The API is unreachable"
          : "This did not load";
  return (
    <div className="state state-error" role="alert">
      <CircleAlert aria-hidden="true" />
      {refusal ? (
        <Refused who={exasolUser} what="this read" message={refusal.message} sql={refusal.sql} />
      ) : (
        <>
          <p className="state-title">{title}</p>
          <p className="state-body">{e?.message ?? "Unknown error."}</p>
        </>
      )}
      {notAssigned && (
        <p className="state-body small">
          Exasol returns only the companies loan operations has assigned to you, through views filtered on
          CURRENT_USER.
        </p>
      )}
      {myBook && (
        <Link className="btn btn-quiet btn-sm" to="/book">
          Go to my companies
        </Link>
      )}
      {retry && status !== 403 && status !== 404 && (
        <button className="btn btn-quiet btn-sm" onClick={retry}>
          <RotateCcw aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
  icon: Icon = Inbox,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="state state-empty">
      <span className="state-icon" aria-hidden="true">
        <Icon />
      </span>
      <p className="state-title">{title}</p>
      {children && <div className="state-body">{children}</div>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  tone = "default",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer: ReactNode;
  tone?: "default" | "danger";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const hid = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${tone}`}
      aria-labelledby={hid}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-inner">
        <h2 id={hid} className="dialog-title">
          {title}
        </h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-foot">{footer}</div>
      </div>
    </dialog>
  );
}

export function KV({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: number }) {
  return (
    <dl className="kv" style={{ ["--kv-cols" as string]: cols }}>
      {items.map(([k, v], i) => (
        <div key={i} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pager({
  page,
  size,
  total,
  onPage,
}: {
  page: number;
  size: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  return (
    <div className="pager">
      <span className="muted">
        <span className="num">{num(from)}</span>–<span className="num">{num(to)}</span> of <span className="num">{num(total)}</span>
      </span>
      <div className="pager-btns">
        <button className="btn btn-quiet btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft aria-hidden="true" />
          Previous
        </button>
        <span className="num muted">
          {page} / {pages}
        </span>
        <button className="btn btn-quiet btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={`seg-btn ${value === o.value ? "is-on" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
