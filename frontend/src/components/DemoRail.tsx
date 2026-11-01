import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  BadgeCheck,
  Briefcase,
  ChevronDown,
  DatabaseZap,
  FlaskConical,
  Gavel,
  Handshake,
  LoaderCircle,
  Play,
  Route,
  ShieldCheck,
  UserPlus,
  UserRoundCog,
  type LucideIcon,
} from "lucide-react";
import type { Role } from "../api/types";
import { useAuth, useUser } from "../auth/AuthContext";
import { fetchDemoUsers, type DemoUser } from "../auth/demo";
import { ROLE_LABEL } from "../lib/roles";

interface Step {
  role: Role;
  icon: LucideIcon;
  does: string;
  cta: { to: string; label: string; icon: LucideIcon };
}

/** The workflow in the order the work moves, one step per role. */
const STEPS: Step[] = [
  {
    role: "datasci",
    icon: FlaskConical,
    does: "Runs the analysis in Exasol and publishes it to loan operations.",
    cta: { to: "/analysis", label: "Run the analysis", icon: Play },
  },
  {
    role: "loanops",
    icon: BadgeCheck,
    does: "Assigns the companies analysed to relationship managers.",
    cta: { to: "/analysis/decisions?assigned=no", label: "Assign companies to RMs", icon: UserPlus },
  },
  {
    role: "rm",
    icon: Handshake,
    does: "Negotiates each pre-approved offer inside Exasol's limits and logs the loan status.",
    cta: { to: "/book", label: "Open my companies", icon: Briefcase },
  },
  {
    role: "admin",
    icon: ShieldCheck,
    does: "Approves model activations and policy proposals.",
    cta: { to: "/admin/approvals", label: "Open approvals", icon: Gavel },
  },
];

const ICON: Record<Role, LucideIcon> = Object.fromEntries(STEPS.map((s) => [s.role, s.icon])) as Record<Role, LucideIcon>;

/** The demo rail at the top of the Overview. It shows the four roles' hand-offs, highlights the viewer's step and lets a demo switch role in one click. */
export function DemoRail() {
  const user = useUser();
  return (
    <section className="rail" aria-label="The workflow across roles">
      <div className="rail-head">
        <p className="rail-title">
          <Route aria-hidden="true" />
          The workflow across roles
          <span className="rail-sub">Each role hands the work on, and Exasol does the analysis in between.</span>
        </p>
        <SwitchRole />
      </div>
      <ol className="rail-steps">
        {STEPS.map((s, i) => {
          const mine = s.role === user.role;
          return (
            <li key={s.role} className={`rail-step ${mine ? "is-mine" : ""}`} aria-current={mine ? "step" : undefined}>
              <span className="rail-n num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="rail-body">
                <span className="rail-role">
                  <s.icon aria-hidden="true" />
                  {ROLE_LABEL[s.role]}
                  {mine && <span className="tag tag-you">you</span>}
                </span>
                <span className="rail-text">{s.does}</span>
                {mine && (
                  <span className="rail-cta">
                    <Link className="btn btn-primary btn-sm" to={s.cta.to}>
                      <s.cta.icon aria-hidden="true" />
                      {s.cta.label}
                    </Link>
                    {s.role === "admin" && (
                      <Link className="btn btn-quiet btn-sm" to="/admin/data">
                        <DatabaseZap aria-hidden="true" />
                        Generate mock data
                      </Link>
                    )}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A small menu of the demo users. Hidden when the deployment publishes no demo passwords. */
function SwitchRole() {
  const user = useUser();
  const { login } = useAuth();
  const nav = useNavigate();
  const [demo, setDemo] = useState<DemoUser[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchDemoUsers(ctrl.signal).then((users) => !ctrl.signal.aborted && setDemo(users));
    return () => ctrl.abort();
  }, []);

  // The menu closes on a click elsewhere or on Escape, and the trigger takes the focus back.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function onMenuKey(e: KeyboardEvent<HTMLUListElement>) {
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  }

  async function switchTo(d: DemoUser) {
    setOpen(false);
    if (d.username === user.username) return;
    setBusy(d.role);
    setError(null);
    try {
      // Signing in as the chosen user replaces this tab's token, user and cached data, which is all signing out does, so the shell stays on screen.
      await login(d.username, d.password);
      nav("/", { replace: true });
    } catch (e) {
      setError(`Could not sign in as ${ROLE_LABEL[d.role]}. ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  if (!demo.length) return null;
  const ordered = STEPS.map((s) => demo.find((d) => d.role === s.role)).filter((d): d is DemoUser => !!d);
  return (
    <div className="rail-switch" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="btn btn-quiet btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="rail-role-menu"
        aria-label={busy ? `Signing in as ${ROLE_LABEL[busy]}` : "Switch demo role"}
        disabled={!!busy}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <UserRoundCog aria-hidden="true" />}
        {busy ? `Signing in as ${ROLE_LABEL[busy]}` : "Switch role"}
        {!busy && <ChevronDown aria-hidden="true" />}
      </button>
      {open && (
        <ul id="rail-role-menu" role="menu" className="rail-menu" aria-label="Demo roles" ref={menu} onKeyDown={onMenuKey}>
          {ordered.map((d) => {
            const Icon = ICON[d.role];
            const current = d.username === user.username;
            return (
              <li key={d.username} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="rail-menu-item"
                  aria-current={current ? "true" : undefined}
                  aria-label={current ? `${ROLE_LABEL[d.role]}, signed in now` : `Sign in as ${ROLE_LABEL[d.role]}`}
                  onClick={() => void switchTo(d)}
                >
                  <Icon aria-hidden="true" />
                  {ROLE_LABEL[d.role]}
                  <code>{d.username}</code>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="rail-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
