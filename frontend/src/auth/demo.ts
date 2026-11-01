// The demo users a deployment lets anyone sign in as (the login page's one-click sign-in uses the same list).
import type { Role } from "../api/types";
import { FIXTURES } from "../lib/env";

export interface DemoUser {
  username: string;
  password: string;
  role: Role;
}

/** The demo usernames are the role names, as backend/app/config.py and the fixture users define them. */
const ROLE_OF: Record<string, Role> = { admin: "admin", datasci: "datasci", loanops: "loanops", rm: "rm" };

/**
 * Lists the demo users with their passwords. Empty when the deployment does not run the public demo,
 * so callers hide their one-click controls. In fixture mode the four roles sign in with any password.
 */
export async function fetchDemoUsers(signal?: AbortSignal): Promise<DemoUser[]> {
  if (FIXTURES) return Object.values(ROLE_OF).map((role) => ({ username: role, password: "fixture", role }));
  try {
    const r = await fetch("/api/auth/demo", { signal, headers: { Accept: "application/json" } });
    if (!r.ok) return [];
    const d = (await r.json()) as { users?: { username: string; password: string }[] };
    return (d.users ?? [])
      .filter((u) => u.username in ROLE_OF && !!u.password)
      .map((u) => ({ username: u.username, password: u.password, role: ROLE_OF[u.username]! }));
  } catch {
    return [];
  }
}
