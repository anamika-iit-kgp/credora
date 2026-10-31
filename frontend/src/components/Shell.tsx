import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  BookOpen,
  BookUser,
  Briefcase,
  ClipboardList,
  DatabaseZap,
  Fingerprint,
  FlaskConical,
  Gavel,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  MessageSquareText,
  Network,
  Radar,
  ScrollText,
  Server,
  SlidersHorizontal,
  Trophy,
  X,
  type LucideIcon,
} from "lucide-react";
import { useAuth, useUser } from "../auth/AuthContext";
import { usePendingApprovals } from "../api/workflow";
import { useNewPublished } from "./PublishedNotice";
import { can, ROLE_LABEL, type Permission } from "../lib/roles";
import { FIXTURES } from "../lib/env";
import { ThemeToggle } from "./ThemeToggle";
import { ExathonMark } from "./ExathonMark";
import { ExplainProvider } from "../explain/ExplainContext";
import { Explain, TermPopover } from "../explain/Explain";
import { Topbar } from "../explain/Topbar";
import { ExasolConsole } from "../explain/ExasolConsole";
import { ActionToasts } from "../explain/ActionToasts";

/** The Credora mark: a cut sapphire, drawn as four facets. */
export function Gem({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="gem">
      <path className="gem-face-d" d="M7.2 3.5h9.6L20.5 9H3.5Z" />
      <path className="gem-face-a" d="M3.5 9h17L12 21.5Z" />
      <path className="gem-face-b" d="M8.6 9h6.8L12 21.5Z" />
      <path className="gem-face-c" d="M3.5 9 8.6 9 12 21.5Z" />
      <path className="gem-edge" d="M7.2 3.5h9.6L20.5 9 12 21.5 3.5 9ZM3.5 9h17M8.6 9 12 3.5 15.4 9" />
    </svg>
  );
}

export function Wordmark({ inverse = false }: { inverse?: boolean }) {
  return (
    <span className={`wordmark ${inverse ? "wordmark-inverse" : ""}`}>
      <Gem />
      <span className="wordmark-text">
        <span className="wordmark-name">Credora</span>
        <span className="wordmark-bank">Sapphire Bank</span>
      </span>
    </span>
  );
}

interface Item {
  to: string;
  label: string;
  icon: LucideIcon;
  perm?: Permission;
  only?: string[];
  end?: boolean;
  badge?: "approvals" | "published"; // pending-count badge, or "New" for a newly published run
}

const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "Credit",
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/book", label: "My companies", icon: BookUser, perm: "myBook" },
      { to: "/companies", label: "Data explorer", icon: Network },
      { to: "/pipeline", label: "My pipeline", icon: Briefcase, only: ["rm"] },
      { to: "/pipeline", label: "Offer pipeline", icon: Briefcase, only: ["admin"] },
      { to: "/queue", label: "Approval queue", icon: Inbox, perm: "checker" },
      { to: "/status", label: "Loan status", icon: ListChecks, perm: "loanStatus" },
    ],
  },
  {
    label: "Exasol",
    items: [
      { to: "/analysis", label: "Analysis runs", icon: Activity, perm: "runs", end: true },
      { to: "/analysis/decisions", label: "Decisions", icon: ClipboardList, perm: "decisions", badge: "published" },
      { to: "/analysis/top50", label: "Top 50", icon: Trophy, perm: "top50" },
      { to: "/models", label: "Risk models", icon: FlaskConical, perm: "models", end: true },
      { to: "/models/whatif", label: "What-if", icon: SlidersHorizontal, perm: "whatif" },
      { to: "/ask", label: "Ask Credora", icon: MessageSquareText, perm: "ask" },
      { to: "/exasol", label: "Exasol control room", icon: Radar },
      { to: "/glossary", label: "Glossary", icon: BookOpen },
    ],
  },
  {
    label: "Administration",
    items: [
      { to: "/admin/data", label: "Data generation", icon: DatabaseZap, perm: "generate" },
      { to: "/admin/sources", label: "Sources", icon: Server, perm: "sources" },
      { to: "/admin/approvals", label: "Approvals", icon: Gavel, perm: "approvePolicy", badge: "approvals" },
      { to: "/admin/audit", label: "Audit and purge", icon: ScrollText, perm: "audit" },
      { to: "/admin/exasol-audit", label: "Exasol audit", icon: Fingerprint, perm: "audit" },
    ],
  },
];

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function Shell() {
  const user = useUser();
  const { logout } = useAuth();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.pathname]);
  const pending = usePendingApprovals(can(user.role, "approvePolicy"));
  const fresh = useNewPublished();
  const badges: Record<NonNullable<Item["badge"]>, number> = {
    approvals: (pending.data?.policy ?? 0) + (pending.data?.models ?? 0),
    published: fresh.isNew ? 1 : 0,
  };

  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => (i.only ? i.only.includes(user.role) : i.perm ? can(user.role, i.perm) : true)),
  })).filter((g) => g.items.length);

  return (
    <ExplainProvider username={user.username} role={user.role}>
    <div className={`shell ${open ? "nav-open" : ""}`}>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <aside className="nav" aria-label="Main">
        <div className="nav-top">
          <NavLink to="/" className="nav-brand" aria-label="Credora overview">
            <Wordmark inverse />
          </NavLink>
          <button className="nav-burger" aria-expanded={open} aria-controls="nav-groups" onClick={() => setOpen((o) => !o)}>
            {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            Menu
          </button>
        </div>
        <div id="nav-groups" className="nav-groups">
          {groups.map((g) => (
            <div key={g.label} className="nav-group">
              <p className="nav-group-label">{g.label}</p>
              <ul>
                {g.items.map((i) => (
                  <li key={i.to + i.label}>
                    <NavLink to={i.to} end={i.end} className={({ isActive }) => `nav-link ${isActive ? "is-active" : ""}`}>
                      <i.icon aria-hidden="true" />
                      {i.label}
                      {i.badge === "published" && badges.published > 0 && (
                        <span className="nav-badge nav-badge-new" aria-label="new results published">
                          New
                        </span>
                      )}
                      {i.badge === "approvals" && badges.approvals > 0 && (
                        <span className="nav-badge num" aria-label={`${badges.approvals} pending`}>
                          {badges.approvals}
                        </span>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="nav-foot">
          {FIXTURES && (
            <p className="nav-fixture" title="The API is answered in the browser with synthetic fixtures">
              <FlaskConical aria-hidden="true" />
              Fixture data, no backend
            </p>
          )}
          <div className="nav-user">
            <span className="nav-avatar" aria-hidden="true">
              {initials(user.display_name)}
            </span>
            <span className="nav-user-name">{user.display_name}</span>
            <span className="nav-user-role">
              {ROLE_LABEL[user.role]} · <code>{user.username}</code>
              <Explain id="user" label={`your role, ${ROLE_LABEL[user.role]}`} />
            </span>
          </div>
          <div className="nav-foot-actions">
            <ThemeToggle />
            <button className="nav-signout" onClick={logout}>
              <LogOut aria-hidden="true" />
              Sign out
            </button>
          </div>
          <ExathonMark variant="nav" />
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        <Topbar />
        <Outlet />
      </main>
      <ExasolConsole role={user.role} />
      <ActionToasts />
      <TermPopover />
    </div>
    </ExplainProvider>
  );
}
