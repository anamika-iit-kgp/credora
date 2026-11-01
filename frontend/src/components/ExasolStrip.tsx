import { useEffect, useMemo, useRef, useState } from "react";
import { matchPath, useLocation } from "react-router-dom";
import { Cpu } from "lucide-react";
import { fetchConsole, type ConsoleEntry } from "../api/exasol";
import { useUser } from "../auth/AuthContext";
import { ms, useConsoleFeed } from "../explain/ExasolConsole";
import { useExplain } from "../explain/ExplainContext";
import { ACTION_EVENT, consoleSession } from "../explain/session";

const POLL_MS = 5000;
const SOON_MS = 1200;
const KEEP = 300;

/** Route path (App.tsx) to the screen name the strip shows. */
const SCREENS: [path: string, name: string][] = [
  ["/", "Overview"],
  ["/companies", "Data explorer"],
  ["/companies/:cif", "Company"],
  ["/companies/:cif/report", "Exasol report"],
  ["/analysis", "Analysis runs"],
  ["/analysis/decisions", "Decisions"],
  ["/analysis/top50", "Top 50"],
  ["/status", "Loan status"],
  ["/book", "My companies"],
  ["/models", "Risk models"],
  ["/models/whatif", "What-if"],
  ["/ask", "Ask Credora"],
  ["/exasol", "Exasol control room"],
  ["/glossary", "Glossary"],
  ["/pipeline", "Offer pipeline"],
  ["/offers/:offerId", "Offer"],
  ["/queue", "Approval queue"],
  ["/admin/data", "Data generation"],
  ["/admin/sources", "Sources"],
  ["/admin/audit", "Audit and purge"],
  ["/admin/exasol-audit", "Exasol audit"],
  ["/admin/approvals", "Approvals"],
];

export function screenName(pathname: string, role: string): string {
  const hit = SCREENS.find(([p]) => matchPath({ path: p, end: true }, pathname));
  if (!hit) return "This screen";
  return hit[0] === "/pipeline" && role === "rm" ? "My pipeline" : hit[1];
}

interface Own {
  entries: ConsoleEntry[];
  last: number;
}

function merge(prev: Own, incoming: ConsoleEntry[], last: number): Own {
  if (!incoming.length && last === prev.last) return prev;
  const byId = new Map(prev.entries.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  const entries = Array.from(byId.values())
    .sort((a, b) => a.seq - b.seq)
    .slice(-KEEP);
  return { entries, last: Math.max(prev.last, last) };
}

/**
 * The compact strip in the top bar. It reads the same /exasol/console feed as the drawer and shows what the
 * current screen ran so far. The drawer polls only with Explain mode on, so the strip polls for itself while
 * the drawer is closed, more often right after a navigation or an action.
 */
export function ExasolStrip() {
  const user = useUser();
  const { on, setOn, consoleOpen, setConsoleOpen, exasolUser } = useExplain();
  const { pathname } = useLocation();
  const feed = useConsoleFeed();
  const [own, setOwn] = useState<Own>({ entries: [], last: 0 });
  const lastRef = useRef(0);
  lastRef.current = own.last;

  // A new screen starts its count at the newest statement known when it opened.
  const [mark, setMark] = useState({ path: pathname, seq: 0 });
  if (mark.path !== pathname) setMark({ path: pathname, seq: Math.max(own.last, feed.last) });

  useEffect(() => {
    if (consoleOpen) return;
    let stop = false;
    let timer = 0;
    const ctrl = new AbortController();
    const tick = async () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") {
        try {
          const page = await fetchConsole(lastRef.current, "session", ctrl.signal);
          if (stop) return;
          setOwn((prev) => merge(prev, page.entries, page.last));
        } catch {
          /* the next tick tries again */
        }
      }
      if (!stop) timer = window.setTimeout(tick, POLL_MS);
    };
    const soon = () => {
      if (stop) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, SOON_MS);
    };
    const onVis = () => document.visibilityState === "visible" && soon();
    soon();
    window.addEventListener(ACTION_EVENT, soon);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      ctrl.abort();
      window.clearTimeout(timer);
      window.removeEventListener(ACTION_EVENT, soon);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [consoleOpen, pathname]);

  const { count, total, who } = useMemo(() => {
    const mine = consoleSession();
    const byId = new Map<number, ConsoleEntry>();
    for (const e of [...feed.entries, ...own.entries]) {
      if (e.session !== null && e.session !== mine) continue;
      const cur = byId.get(e.id);
      if (!cur || cur.seq < e.seq) byId.set(e.id, e);
    }
    const ran = Array.from(byId.values())
      .filter((e) => e.kind === "sql" && e.seq > mark.seq)
      .sort((a, b) => a.seq - b.seq);
    const newest = ran[ran.length - 1];
    return {
      count: ran.length,
      total: ran.reduce((s, e) => s + (e.ms ?? 0), 0),
      who: exasolUser ?? newest?.exa_user,
    };
  }, [feed, own, mark.seq, exasolUser]);

  const screen = screenName(pathname, user.role);
  const noun = count === 1 ? "statement" : "statements";
  const label =
    `${screen} ran ${count} Exasol ${noun}${count ? ` in ${ms(total)}` : ""}${who ? ` as ${who}` : ""}. ` +
    (consoleOpen ? "Close the Exasol console." : "Open the Exasol console.");

  function toggle() {
    if (consoleOpen) {
      setConsoleOpen(false);
      return;
    }
    // The drawer is part of Explain mode, so opening it switches the mode on.
    if (!on) setOn(true);
    setConsoleOpen(true);
  }

  return (
    <button type="button" className={`xstrip ${consoleOpen ? "is-on" : ""}`} aria-label={label} aria-pressed={consoleOpen} onClick={toggle}>
      <Cpu aria-hidden="true" />
      <span className="xstrip-screen">{screen}</span>
      <span className="xstrip-sep xstrip-sep-screen" aria-hidden="true">
        ·
      </span>
      <span className="num">{count}</span>
      <span className="xstrip-word">{noun}</span>
      <span className="xstrip-short">SQL</span>
      {count > 0 && (
        <>
          <span className="xstrip-sep" aria-hidden="true">
            ·
          </span>
          <span className="num">{ms(total)}</span>
        </>
      )}
      {who && (
        <span className="xstrip-user">
          <span className="xstrip-sep" aria-hidden="true">
            ·
          </span>
          as <code>{who}</code>
        </span>
      )}
    </button>
  );
}
