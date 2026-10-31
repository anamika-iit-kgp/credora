import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDownToLine, Bot, CircleAlert, Cpu, Eraser, Pause, Play, SquareTerminal, X } from "lucide-react";
import { fetchConsole, type ConsoleEntry, type ConsoleScope } from "../api/exasol";
import { tokenize } from "../lib/highlight";
import { useExplain } from "./ExplainContext";
import { Explain } from "./Explain";

const OPEN_POLL_MS = 1500;
const CLOSED_POLL_MS = 15_000;
const KEEP = 300;

/* ---------- a tiny store shared by the header button (unread count) and the drawer ---------- */

interface Feed {
  entries: ConsoleEntry[];
  last: number;
  seen: number;
  error: string | null;
}
let feed: Feed = { entries: [], last: 0, seen: 0, error: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => feed;

function merge(incoming: ConsoleEntry[], last: number) {
  if (!incoming.length && last === feed.last) return;
  const byId = new Map(feed.entries.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  const entries = Array.from(byId.values())
    .sort((a, b) => a.seq - b.seq)
    .slice(-KEEP);
  feed = { ...feed, entries, last: Math.max(feed.last, last), error: null };
  emit();
}

function resetFeed() {
  feed = { entries: [], last: 0, seen: 0, error: null };
  emit();
}

export function useConsoleFeed() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function unreadCount(f: Feed) {
  return f.entries.filter((e) => e.seq > f.seen).length;
}

/** Polls the backend: every 1.5 s while the drawer is open, every 15 s (for the unread count) while closed. */
function usePoll(open: boolean, scope: ConsoleScope, paused: boolean) {
  const scopeRef = useRef(scope);
  useEffect(() => {
    if (scopeRef.current !== scope) {
      scopeRef.current = scope;
      resetFeed();
    }
  }, [scope]);
  useEffect(() => {
    if (paused) return;
    let stop = false;
    let timer = 0;
    const ctrl = new AbortController();
    const tick = async () => {
      try {
        const page = await fetchConsole(feed.last, scope, ctrl.signal);
        if (stop) return;
        merge(page.entries, page.last);
        if (open) {
          feed = { ...feed, seen: feed.last };
          emit();
        }
      } catch (e) {
        if (stop || (e as Error).name === "AbortError") return;
        feed = { ...feed, error: (e as Error).message };
        emit();
      }
      if (!stop) timer = window.setTimeout(tick, open ? OPEN_POLL_MS : CLOSED_POLL_MS);
    };
    // A hidden tab does not poll.
    const onVis = () => {
      if (document.visibilityState === "visible" && !stop) {
        window.clearTimeout(timer);
        void tick();
      }
    };
    void tick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      ctrl.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [open, scope, paused]);
}

/* ---------- formatting ---------- */

const time = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleTimeString("en-GB", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
export const ms = (v: number | null) => (v == null ? "" : v < 1000 ? `${v < 10 ? v.toFixed(1) : Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
const rows = (n: number | null) => (n == null ? "" : `${n.toLocaleString("en-IN")} ${n === 1 ? "row" : "rows"}`);

const KIND: Record<ConsoleEntry["kind"], string> = { sql: "SQL", step: "Step", mcp: "MCP", event: "Event" };

function Sql({ code }: { code: string }) {
  const tokens = useMemo(() => tokenize(code, "sql"), [code]);
  return (
    <code>
      {tokens.map((t, i) =>
        t.t === "txt" || t.t === "op" ? (
          t.v
        ) : (
          <span key={i} className={`tk-${t.t}`}>
            {t.v}
          </span>
        ),
      )}
    </code>
  );
}

const Row = memo(function Row({ e, showUser }: { e: ConsoleEntry; showUser: boolean }) {
  const [open, setOpen] = useState(false);
  const sql = e.sql ?? "";
  const long = sql.split("\n").length > 3 || sql.length > 260;
  return (
    <li className={`xc-row xc-${e.kind} ${e.error ? "is-error" : ""}`}>
      <span className="xc-time num">{time(e.at)}</span>
      <span className={`xc-kind xc-kind-${e.kind}`}>{KIND[e.kind]}</span>
      <div className="xc-main">
        <p className="xc-meta">
          {e.exa_user && <code className="xc-user">{e.exa_user}</code>}
          {showUser && e.username && <span className="xc-app">{e.username}</span>}
          {e.label && <span className="xc-label">{e.label}</span>}
          {e.tool && <span className="xc-label">tool {e.tool}</span>}
        </p>
        {e.via && (
          <p className="xc-via">
            <Bot aria-hidden="true" />
            {e.via}
          </p>
        )}
        {e.sql ? (
          <pre className={`xc-sql ${open ? "is-open" : ""}`}>
            <Sql code={sql} />
          </pre>
        ) : (
          <p className="xc-text">{e.text}</p>
        )}
        {long && (
          <button type="button" className="xp-link-btn xc-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Show less" : "Show the whole statement"}
          </button>
        )}
        {e.error && (
          <p className="xc-error">
            <CircleAlert aria-hidden="true" />
            {e.error}
          </p>
        )}
      </div>
      <span className="xc-stats num">
        {e.repeat > 1 && <span className="xc-repeat">×{e.repeat}</span>}
        {e.ms != null && <span>{ms(e.ms)}</span>}
        {e.rows != null && <span className="muted">{rows(e.rows)}</span>}
      </span>
    </li>
  );
});

/** The Exasol console: a bottom drawer listing, live, every statement the backend ran in Exasol for this tab. */
export function ExasolConsole({ role }: { role: string }) {
  const { on, consoleOpen, setConsoleOpen, exasolUser } = useExplain();
  const [scope, setScope] = useState<ConsoleScope>("session");
  const [paused, setPaused] = useState(false);
  const [clearedAt, setClearedAt] = useState(0);
  const f = useConsoleFeed();
  usePoll(consoleOpen, scope, !on || paused);

  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const shown = f.entries.filter((e) => e.seq > clearedAt);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, f.last, consoleOpen]);

  if (!on || !consoleOpen) return null;
  const scopes: { v: ConsoleScope; label: string }[] = [
    { v: "session", label: "This tab" },
    { v: "user", label: "All my tabs" },
    ...(role === "admin" ? [{ v: "all" as const, label: "Everyone" }] : []),
  ];
  return (
    <section className="xc" aria-label="Exasol console">
      <header className="xc-bar">
        <p className="xc-title">
          <SquareTerminal aria-hidden="true" />
          Exasol console
          <span className={`xc-live ${paused ? "is-paused" : ""}`} aria-hidden="true" />
          <span className="xc-sub">
            {paused ? "paused" : "live"} · {shown.length} {shown.length === 1 ? "entry" : "entries"}
            {exasolUser && (
              <>
                {" "}
                · reads as <code>{exasolUser}</code>
              </>
            )}
          </span>
          <Explain id="exasol-console" label="the Exasol console" />
        </p>
        <div className="xc-tools">
          <div className="seg seg-sm" role="radiogroup" aria-label="Whose statements">
            {scopes.map((s) => (
              <button
                key={s.v}
                type="button"
                role="radio"
                aria-checked={scope === s.v}
                className={`seg-btn ${scope === s.v ? "is-on" : ""}`}
                onClick={() => setScope(s.v)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
            {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setClearedAt(f.last)} disabled={!shown.length}>
            <Eraser aria-hidden="true" />
            Clear
          </button>
          <button type="button" className="btn btn-quiet btn-sm xc-close" aria-label="Close the Exasol console" onClick={() => setConsoleOpen(false)}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      {f.error && <p className="xc-warn">The console could not refresh. {f.error}</p>}
      {shown.length === 0 ? (
        <div className="xc-empty">
          <Cpu aria-hidden="true" />
          <p>
            Nothing yet. Open a screen or start an action, and every statement the backend sends to Exasol for this tab appears here, with the
            Exasol user it ran as, its time and its rows.
          </p>
        </div>
      ) : (
        <ol
          ref={list}
          className="xc-list"
          tabIndex={0}
          aria-label="Statements, oldest first"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {shown.map((e) => (
            <Row key={e.id} e={e} showUser={scope === "all"} />
          ))}
        </ol>
      )}
      {!stick.current && shown.length > 0 && (
        <button
          type="button"
          className="btn btn-sm xc-jump"
          onClick={() => {
            stick.current = true;
            if (list.current) list.current.scrollTop = list.current.scrollHeight;
          }}
        >
          <ArrowDownToLine aria-hidden="true" />
          Latest
        </button>
      )}
    </section>
  );
}
