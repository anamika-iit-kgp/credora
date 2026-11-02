import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ACTION_EVENT } from "./session";
import { ACTION_EXPLAIN } from "./actions";
import { prefetchGlossary } from "./glossaryStore";

/** One action explanation on screen (a toast). */
export interface ActionToast {
  key: number;
  action: string;
}

interface ExplainState {
  /** Explain mode: hints, banners, badges, action toasts and the Exasol console. Off = a plain CRM. */
  on: boolean;
  setOn: (v: boolean) => void;
  consoleOpen: boolean;
  setConsoleOpen: (v: boolean) => void;
  /** The term whose popover is open, and the element it points at. */
  term: { id: string; anchor: HTMLElement | null } | null;
  openTerm: (id: string, anchor: HTMLElement | null) => void;
  closeTerm: () => void;
  toasts: ActionToast[];
  dismissToast: (key: number) => void;
  /** The signed-in viewer's Exasol user, e.g. CREDORA_RM. */
  exasolUser: string | null;
}

const NOOP = () => {};
const Ctx = createContext<ExplainState>({
  on: false,
  setOn: NOOP,
  consoleOpen: false,
  setConsoleOpen: NOOP,
  term: null,
  openTerm: NOOP,
  closeTerm: NOOP,
  toasts: [],
  dismissToast: NOOP,
  exasolUser: null,
});

export const useExplain = () => useContext(Ctx);

const ROLE_EXASOL_USER: Record<string, string> = {
  admin: "CREDORA_ADMIN",
  datasci: "CREDORA_DATASCI",
  loanops: "CREDORA_LOANOPS",
  rm: "CREDORA_RM",
};

function readFlag(key: string, fallback: boolean, store: () => Storage): boolean {
  try {
    const v = store().getItem(key);
    return v === null ? fallback : v === "on";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, v: boolean, store: () => Storage) {
  try {
    store().setItem(key, v ? "on" : "off");
  } catch {
    /* storage unavailable: the choice lasts for this page */
  }
}

const local = () => localStorage;
const session = () => sessionStorage;

export function ExplainProvider({ username, role, children }: { username: string; role: string; children: ReactNode }) {
  const modeKey = `credora.explain.${username}`;
  const consoleKey = `credora.console.open.${username}`;
  const [on, setOnState] = useState(() => readFlag(modeKey, true, local));
  const [consoleOpen, setConsoleState] = useState(() => readFlag(consoleKey, false, session));
  const [term, setTerm] = useState<ExplainState["term"]>(null);
  const [toasts, setToasts] = useState<ActionToast[]>([]);
  const next = useRef(1);

  // Another viewer signing in on this browser gets their own remembered choice.
  useEffect(() => {
    setOnState(readFlag(modeKey, true, local));
    setConsoleState(readFlag(consoleKey, false, session));
  }, [modeKey, consoleKey]);

  const setOn = useCallback(
    (v: boolean) => {
      setOnState(v);
      writeFlag(modeKey, v, local);
      if (!v) {
        setTerm(null);
        setToasts([]);
      }
    },
    [modeKey],
  );
  const setConsoleOpen = useCallback(
    (v: boolean) => {
      setConsoleState(v);
      writeFlag(consoleKey, v, session);
    },
    [consoleKey],
  );

  // The term data is a separate download. It starts as soon as hints are on, so it is normally in before the first click;
  // a click also asks for it, which retries a download that failed earlier.
  useEffect(() => {
    if (on) prefetchGlossary();
  }, [on]);

  const openTerm = useCallback((id: string, anchor: HTMLElement | null) => {
    prefetchGlossary();
    setTerm({ id, anchor });
  }, []);
  const closeTerm = useCallback(() => setTerm(null), []);
  const dismissToast = useCallback((key: number) => setToasts((t) => t.filter((x) => x.key !== key)), []);

  // Every action the API client starts (see session.ts) gets an explanation in Exasol's words.
  useEffect(() => {
    if (!on) return;
    const onAction = (e: Event) => {
      const action = (e as CustomEvent<{ action: string }>).detail?.action;
      if (!action || !ACTION_EXPLAIN[action]) return;
      // An action already explained on screen (a what-if slider, repeated quotes) is not shown again.
      setToasts((t) => (t.some((x) => x.action === action) ? t : [...t, { key: next.current++, action }].slice(-2)));
    };
    window.addEventListener(ACTION_EVENT, onAction);
    return () => window.removeEventListener(ACTION_EVENT, onAction);
  }, [on]);

  // The page reserves room for the drawer only while it is shown.
  const showConsole = on && consoleOpen;
  useEffect(() => {
    document.documentElement.toggleAttribute("data-console-open", showConsole);
    return () => document.documentElement.removeAttribute("data-console-open");
  }, [showConsole]);

  const value = useMemo<ExplainState>(
    () => ({
      on,
      setOn,
      consoleOpen: showConsole,
      setConsoleOpen,
      term: on ? term : null,
      openTerm,
      closeTerm,
      toasts: on ? toasts : [],
      dismissToast,
      exasolUser: ROLE_EXASOL_USER[role] ?? null,
    }),
    [on, setOn, showConsole, setConsoleOpen, term, openTerm, closeTerm, toasts, dismissToast, role],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
