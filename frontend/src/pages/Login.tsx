import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, BadgeCheck, FlaskConical, Handshake, LoaderCircle, LogIn, ShieldCheck, type LucideIcon } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { SourceTag } from "../components/SourceTag";
import { BrandLogo, ExasolLogo } from "../components/BrandLogo";
import { Wordmark } from "../components/Shell";
import { ThemeToggle } from "../components/ThemeToggle";
import { ExathonMark } from "../components/ExathonMark";
import { FIXTURES } from "../lib/env";
import type { Role } from "../api/types";
import { ROLE_LABEL } from "../lib/roles";

const DEMO: { username: string; role: Role; does: string; icon: LucideIcon }[] = [
  { username: "admin", role: "admin", does: "Bank manager. Generates mock data, approves policy and model activations, sees everything", icon: ShieldCheck },
  { username: "datasci", role: "datasci", does: "Runs and publishes the analysis, trains models, proposes policy", icon: FlaskConical },
  { username: "loanops", role: "loanops", does: "Assigns companies to RMs, verifies and sanctions escalations", icon: BadgeCheck },
  { username: "rm", role: "rm", does: "Works only her assigned companies, negotiates, logs loan status", icon: Handshake },
];

// Every source the analysis reads, as tagged everywhere in the app.
const INPUTS: [string, string][] = [
  ["bank.oracle", "Core banking accounts and 8.5 lakh current-account transactions, read in place"],
  ["bank.mysql", "Customer master of companies, partners and KYC"],
  ["bank.postgres", "Credit needs on file, past loans with outcomes, CRM"],
  ["api.cibil", "Credit bureau reports for every partner and company"],
  ["api.gstn", "2 to 10 years of monthly GST returns"],
  ["api.aa", "Partners' accounts at other banks, with consent"],
];
const RESULT = "Features, risk, decision, offer, limit and rank, computed inside Exasol";

// Geometry of the flow: six input rows of equal pitch converge on the Exasol node.
const ROW = 62;
const H = ROW * INPUTS.length;
const W = 84;

function Flow() {
  const reduce = useReducedMotion();
  const ease = [0.23, 1, 0.32, 1] as const;
  return (
    <div className="flow" role="group" aria-label="Where Credora's data comes from">
      <ul className="flow-inputs">
        {INPUTS.map(([src, text], i) => (
          <motion.li
            key={src}
            className="flow-in"
            style={{ height: ROW }}
            initial={reduce ? false : { opacity: 0, transform: "translateX(-10px)" }}
            animate={{ opacity: 1, transform: "translateX(0px)" }}
            transition={{ duration: 0.5, delay: 0.35 + i * 0.06, ease }}
          >
            <span className="brand-tile">
              <BrandLogo source={src} size={src === "bank.oracle" ? 18 : src === "bank.mysql" ? 32 : 22} />
            </span>
            <span className="flow-in-body">
              <SourceTag source={src} />
              <span className="flow-in-text">{text}</span>
            </span>
          </motion.li>
        ))}
      </ul>
      <svg className="flow-wires" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
        {INPUTS.map(([src], i) => {
          const y = ROW * i + ROW / 2;
          const d = `M0 ${y} C ${W * 0.55} ${y}, ${W * 0.45} ${H / 2}, ${W} ${H / 2}`;
          const kind = src.startsWith("api") ? "api" : "bank";
          return (
            <g key={src} className={`wire wire-${kind}`}>
              <motion.path
                d={d}
                className="wire-base"
                initial={reduce ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.7, delay: 0.55 + i * 0.06, ease }}
              />
              <path d={d} className="wire-pulse" style={{ animationDelay: `${i * -0.35}s` }} />
            </g>
          );
        })}
      </svg>
      <motion.div
        className="flow-core"
        initial={reduce ? false : { opacity: 0, transform: "scale(0.94)" }}
        animate={{ opacity: 1, transform: "scale(1)" }}
        transition={{ duration: 0.6, delay: 0.9, ease }}
      >
        <span className="flow-core-logo">
          <ExasolLogo height={30} />
        </span>
        <SourceTag source="exasol" />
        <p className="flow-core-text">{RESULT}</p>
        <p className="flow-core-out">
          <ArrowRight aria-hidden="true" />
          <span>
            <strong>Lightning-fast in-database ML.</strong> Every pre-approved offer scored, priced and ranked in one run
          </span>
        </p>
      </motion.div>
    </div>
  );
}

export function LoginPage() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? "/";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pw = useRef<HTMLInputElement>(null);
  const [demo, setDemo] = useState<Record<string, string>>({});
  const reduce = useReducedMotion();

  useEffect(() => {
    if (FIXTURES) return;
    fetch("/api/auth/demo")
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d: { users: { username: string; password: string }[] }) =>
        setDemo(Object.fromEntries(d.users.map((x) => [x.username, x.password]))),
      )
      .catch(() => undefined);
  }, []);

  if (user) return <Navigate to={from} replace />;

  async function submit(u: string, p: string) {
    setBusy(true);
    setError(null);
    try {
      await login(u, p);
      nav(from, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!username || !password) {
      setError("Enter a username and password.");
      return;
    }
    void submit(username.trim(), password);
  }

  async function pickDemo(u: string) {
    setUsername(u);
    setError(null);
    if (FIXTURES) {
      void submit(u, "fixture");
      return;
    }
    // One click signs in: use the demo password if it has loaded, otherwise fetch it now.
    let known: string | undefined = demo[u];
    if (!known) {
      try {
        const r = await fetch("/api/auth/demo");
        const d: { users: { username: string; password: string }[] } = r.ok ? await r.json() : { users: [] };
        const map = Object.fromEntries(d.users.map((x) => [x.username, x.password]));
        setDemo(map);
        known = map[u];
      } catch {
        known = undefined;
      }
    }
    if (known) {
      void submit(u, known);
      return;
    }
    setPassword("");
    pw.current?.focus();
  }

  const ease = [0.23, 1, 0.32, 1] as const;
  const rise = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, transform: "translateY(10px)" },
          animate: { opacity: 1, transform: "translateY(0px)" },
          transition: { duration: 0.6, delay, ease },
        };

  return (
    <div className="login">
      <section className="login-story" aria-label="About Credora">
        <div className="login-glow" aria-hidden="true" />
        <Wordmark inverse />
        <div className="login-story-body">
          <motion.h1 className="login-headline" {...rise(0.05)}>
            Pre-approved corporate loans for Sapphire Bank, every number traced to its source.
          </motion.h1>
          <motion.p className="login-sub" {...rise(0.15)}>
            Credora analyses every corporate customer of the bank, joining its own books with CIBIL, GST and Account Aggregator
            data, and lets Exasol decide, price and rank a pre-approved loan offer for the entity.
          </motion.p>
          <Flow />
        </div>
        <div className="login-foot">
          <ExathonMark variant="login" />
          <div className="login-byline">
            <p className="login-author">
              Project by <strong>Anamika</strong>, Product Manager @ Equitas Small Finance Bank
            </p>
            <p className="login-synthetic">All companies, people and accounts are synthetic.</p>
          </div>
        </div>
      </section>

      <section className="login-form-wrap">
        <div className="login-theme">
          <ThemeToggle className="btn btn-quiet btn-sm" />
        </div>
        <motion.div className="login-card" {...rise(0.1)}>
          <form className="login-form" onSubmit={onSubmit} noValidate>
            <div className="login-form-head">
              <h2 className="login-form-title">Sign in to Credora</h2>
            </div>
            <label className="field">
              <span className="field-label">Username</span>
              <input
                className="input"
                autoComplete="username"
                name="username"
                spellCheck={false}
                autoCapitalize="none"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input
                ref={pw}
                className="input"
                type="password"
                autoComplete="current-password"
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn-primary btn-block" disabled={busy}>
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <LogIn aria-hidden="true" />}
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="demo">
            <div className="demo-head">
              <h3 className="demo-title">Demo users</h3>
              <p className="demo-note">
                {FIXTURES
                  ? "Fixture mode. Pick a role to sign in straight away."
                  : Object.keys(demo).length
                    ? "Pick a role to sign in straight away. All data is synthetic."
                    : "Pick a role to fill in the username. Passwords are set per deployment in the environment file."}
              </p>
            </div>
            <ul className="demo-list">
              {DEMO.map((d) => (
                <li key={d.username}>
                  <button className="demo-pick" onClick={() => void pickDemo(d.username)} disabled={busy}>
                    <span className="demo-icon" aria-hidden="true">
                      <d.icon />
                    </span>
                    <span className="demo-text">
                      <span className="demo-role">
                        {ROLE_LABEL[d.role]} <code className="demo-user">{d.username}</code>
                      </span>
                      <span className="demo-does">{d.does}</span>
                    </span>
                    <ArrowRight className="demo-go" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </motion.div>
      </section>
    </div>
  );
}
