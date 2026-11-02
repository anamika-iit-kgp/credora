// Explain mode fixtures: what each role's Exasol user can read in the control room, and the simulated Exasol console.
import { describe, expect, it } from "vitest";
import type { ConsoleEntry, ControlRoom, Section } from "../api/exasol";
import type { Role } from "../api/types";
import { controlRoomFixture, exasolFixture, recordFixture } from "./exasol";

const ROLES: Role[] = ["admin", "datasci", "loanops", "rm"];

interface Grant {
  privilege: string;
  type: string;
  object: string;
}
interface Security {
  scope: "dba" | "own";
  roles: { role: string; users: string[]; system: string[]; objects: Grant[] }[];
  users: string[];
}

/** The data of a section that the role may read; fails the test when it was refused. */
function data<T>(s: Section<T> | null | undefined): T {
  if (!s || !s.ok) throw new Error("section was refused or missing");
  return s.data;
}

const room = (role: Role) => controlRoomFixture(role);
const security = (role: Role) => data(room(role).security as unknown as Section<Security>);

describe("the control room of each role", () => {
  it("reads as the Exasol user that belongs to the role", () => {
    for (const role of ROLES) {
      const cr: ControlRoom = room(role);
      expect(cr.role).toBe(role);
      expect(cr.exasol_user).toBe(`CREDORA_${role.toUpperCase()}`);
      expect(data(cr.system).current_user).toBe(cr.exasol_user);
    }
  });

  it("shows the admin every Exasol role and user, and the others only their own", () => {
    const admin = security("admin");
    expect(admin.scope).toBe("dba");
    expect(admin.roles.map((r) => r.role).sort()).toEqual(["R_ADMIN", "R_DATASCI", "R_LOANOPS", "R_MCP", "R_RM", "R_SVC"]);
    expect(admin.users).toContain("CREDORA_RM");
    for (const role of ["datasci", "loanops", "rm"] as const) {
      const s = security(role);
      expect(s.scope).toBe("own");
      expect(s.roles.map((r) => r.role)).toEqual([`R_${role.toUpperCase()}`]);
      expect(s.users).toEqual([]);
    }
  });

  it("refuses the relationship manager the model registry and lets the other roles read it", () => {
    const rm = room("rm").models;
    expect(rm.ok).toBe(false);
    if (!rm.ok) {
      expect(rm.denied).toBe(true);
      expect(rm.error).toContain("insufficient privileges");
      expect(rm.error).toContain("MODEL_REGISTRY");
    }
    for (const role of ["admin", "datasci", "loanops"] as const) {
      const models = data(room(role).models);
      expect(models.filter((m) => m.active)).toHaveLength(1);
      for (const m of models) {
        expect(m.auc).not.toBeNull();
        expect(m.gini).toBeCloseTo(2 * (m.auc as number) - 1, 3);
      }
    }
  });

  it("lists the open database sessions for the admin alone", () => {
    expect(data(room("admin").sessions).length).toBeGreaterThan(0);
    for (const role of ["datasci", "loanops", "rm"] as const) expect(room(role).sessions).toBeNull();
  });

  it("hides the bank's virtual schemas from the relationship manager", () => {
    for (const role of ROLES) {
      const byName = Object.fromEntries(data(room(role).schemas).map((s) => [s.name, s]));
      for (const vs of ["VS_CBS", "VS_CIF", "VS_LOS"]) {
        expect(byName[vs].virtual).toBe(true);
        expect(byName[vs].visible > 0).toBe(role !== "rm");
      }
    }
  });

  it("shows the staged API replies to the admin and the data scientist only", () => {
    for (const role of ROLES) {
      const stage = data(room(role).schemas).find((s) => s.name === "CREDORA_STAGE");
      expect((stage?.visible ?? 0) > 0).toBe(role === "admin" || role === "datasci");
    }
  });

  it("shows the relationship manager fewer Credora objects, with no scripts", () => {
    const credora = (role: Role) => data(room(role).schemas).find((s) => s.name === "CREDORA")!;
    expect(credora("rm").visible).toBeLessThan(credora("admin").visible);
    expect(credora("rm").counts.script ?? 0).toBe(0);
    expect(data(room("rm").scripts).items.some((s) => s.schema === "CREDORA")).toBe(false);
    expect(data(room("admin").scripts).items.some((s) => s.schema === "CREDORA")).toBe(true);
  });

  it("adds up the visible objects of every schema and the script total", () => {
    for (const role of ROLES) {
      for (const s of data(room(role).schemas)) expect(s.visible, `${role} ${s.name}`).toBe(Object.values(s.counts).reduce((a, b) => a + b, 0));
      const sc = data(room(role).scripts);
      expect(sc.total).toBe(Object.values(sc.per_schema).reduce((a, b) => a + b, 0));
    }
  });

  it("logs the thirteen steps of the run in order", () => {
    const steps = data(room("admin").run_log).steps;
    expect(steps).toHaveLength(13);
    steps.forEach((s, i) => {
      expect(s.n).toBe(i + 1);
      expect(s.status).toBe("OK");
    });
  });

  it("lists each metric once and marks a filtered metric as filtered", () => {
    const metrics = data(room("admin").semantic).metrics;
    expect(new Set(metrics.map((m) => m.name)).size).toBe(metrics.length);
    for (const m of metrics) expect(m.kind).toBe(m.filter ? "FILTERED" : "SIMPLE");
  });
});

describe("the Exasol grants behind the roles", () => {
  const grants = Object.fromEntries(security("admin").roles.map((r) => [r.role, r]));
  const objects = (role: string) => grants[role].objects;

  it("give only the service account the right to write", () => {
    for (const [name, g] of Object.entries(grants)) {
      const writes = g.objects.filter((o) => o.privilege !== "SELECT");
      if (name === "R_SVC") expect(writes.length).toBeGreaterThan(0);
      else expect(writes, name).toEqual([]);
    }
  });

  it("keep the relationship manager to views, the run log and the config, never the decision tables", () => {
    const names = objects("R_RM").map((o) => o.object);
    for (const forbidden of ["CREDORA.DECISIONS", "CREDORA.SCORES", "CREDORA.FEATURES", "CREDORA.MODEL_REGISTRY", "CREDORA.ANOMALY", "CREDORA_STAGE", "VS_CIF", "VS_CBS", "VS_LOS"]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    for (const o of objects("R_RM").filter((x) => x.type === "VIEW")) expect(o.object).toMatch(/^CREDORA\.V_(RM|LATEST)_/);
    expect(names).toContain("CREDORA.V_RM_DECISIONS");
    expect(names).toContain("CREDORA.V_RM_LOAN_STATUS");
  });

  it("give loan operations no access to the staged API replies", () => {
    expect(objects("R_LOANOPS").map((o) => o.object)).not.toContain("CREDORA_STAGE");
    expect(objects("R_ADMIN").map((o) => o.object)).toContain("CREDORA_STAGE");
    expect(objects("R_DATASCI").map((o) => o.object)).toContain("CREDORA_STAGE");
  });

  it("give the outside AI client read access to results only", () => {
    expect(grants.R_MCP.users).toEqual(["CREDORA_MCP"]);
    for (const o of objects("R_MCP")) {
      expect(o.privilege).toBe("SELECT");
      expect(["TABLE", "VIEW"]).toContain(o.type);
    }
  });

  it("give each person's AI session user the same role as the person", () => {
    for (const [role, base] of [["R_ADMIN", "CREDORA_ADMIN"], ["R_DATASCI", "CREDORA_DATASCI"], ["R_LOANOPS", "CREDORA_LOANOPS"], ["R_RM", "CREDORA_RM"]]) {
      expect(grants[role].users).toContain(base);
      expect(grants[role].users).toContain(`${base}_AI`);
    }
  });
});

describe("the simulated Exasol console", () => {
  const user = (n: string, role: Role) => ({ username: n, role });
  const entries = (u: { username: string; role: Role }, query = "", session: string | null = null) => {
    const r = exasolFixture(u, "/api/exasol/console", new URLSearchParams(query), session);
    return r?.body as { entries: ConsoleEntry[]; last: number; scope: string; exasol_user: string };
  };

  it("leaves paths that are not its own to the other fixtures", () => {
    expect(exasolFixture(user("c0", "admin"), "/api/top50", new URLSearchParams(), null)).toBeUndefined();
    expect(exasolFixture(user("c0", "admin"), "/api/exasol/other", new URLSearchParams(), null)).toBeUndefined();
  });

  it("answers the control room with the role's own room", () => {
    for (const role of ROLES) {
      const r = exasolFixture(user("c1", role), "/api/exasol/control-room", new URLSearchParams(), null);
      expect(r?.status).toBe(200);
      expect((r?.body as ControlRoom).role).toBe(role);
    }
  });

  it("shows a user the statements a request ran, as the Exasol user of the role", () => {
    const u = user("c2", "loanops");
    recordFixture(u, "GET", "/api/top50", "tab-a");
    const e = entries(u, "scope=session", "tab-a");
    expect(e.exasol_user).toBe("CREDORA_LOANOPS");
    expect(e.entries).toHaveLength(1);
    expect(e.entries[0]).toMatchObject({ kind: "sql", exa_user: "CREDORA_LOANOPS", label: "Top 50", username: "c2", role: "loanops", session: "tab-a", repeat: 1 });
    expect(e.entries[0].sql).toContain("CREDORA.DECISIONS");
    expect(e.entries[0].ms).toBeGreaterThan(0);
  });

  it("reads the relationship manager's statements from the row-filtered views", () => {
    const rm = user("c3", "rm");
    const admin = user("c4", "admin");
    recordFixture(rm, "GET", "/api/companies", "t");
    recordFixture(admin, "GET", "/api/companies", "t");
    const rmSql = entries(rm).entries.map((x) => x.sql).join("\n");
    const adminSql = entries(admin).entries.map((x) => x.sql).join("\n");
    expect(rmSql).toContain("V_RM_COMPANY");
    expect(rmSql).not.toContain("VS_CIF");
    expect(adminSql).toContain("VS_CIF");
    expect(adminSql).not.toContain("V_RM_COMPANY");
  });

  it("counts a repeated statement instead of listing it again", () => {
    const u = user("c5", "datasci");
    recordFixture(u, "GET", "/api/ml/models", "t");
    recordFixture(u, "GET", "/api/ml/models", "t");
    const e = entries(u).entries;
    expect(e).toHaveLength(1);
    expect(e[0].repeat).toBe(2);
  });

  it("returns only the entries after `since`, and the last sequence number", () => {
    const u = user("c6", "datasci");
    recordFixture(u, "GET", "/api/ml/models", "t");
    const first = entries(u);
    recordFixture(u, "GET", "/api/runs", "t");
    const next = entries(u, `since=${first.last}`);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0].label).toBe("Analysis runs");
    expect(next.last).toBeGreaterThan(first.last);
    expect(entries(u, `since=${next.last}`).entries).toEqual([]);
    expect(entries(u, `since=${next.last}`).last).toBe(next.last);
  });

  it("separates the browser tabs, and shows a user's own statements across tabs on request", () => {
    const u = user("c7", "admin");
    recordFixture(u, "GET", "/api/runs", "tab-1");
    recordFixture(u, "GET", "/api/ml/models", "tab-2");
    expect(entries(u, "scope=session", "tab-1").entries.map((x) => x.session)).toEqual(["tab-1"]);
    expect(entries(u, "scope=session", "tab-2").entries.map((x) => x.session)).toEqual(["tab-2"]);
    expect(entries(u, "scope=user", "tab-1").entries).toHaveLength(2);
  });

  it("lets only the admin see every user's statements", () => {
    const rm = user("c8", "rm");
    const admin = user("c9", "admin");
    recordFixture(rm, "GET", "/api/overview", "t");
    const refused = exasolFixture(rm, "/api/exasol/console", new URLSearchParams("scope=all"), "t");
    expect(refused?.status).toBe(403);
    expect(refused?.body).toEqual({ detail: "Only the admin may see every user's Exasol statements." });
    const seen = entries(admin, "scope=all");
    expect(seen.entries.some((x) => x.username === "c8")).toBe(true);
  });

  it("does not record the console's own requests or job polling", () => {
    const u = user("c10", "admin");
    recordFixture(u, "GET", "/api/exasol/console", "t");
    recordFixture(u, "GET", "/api/jobs/anything", "t");
    expect(entries(u).entries).toEqual([]);
  });

  it("keeps the newest 200 statements of a user, in order", () => {
    const u = user("c11", "admin");
    for (let i = 0; i < 80; i++) recordFixture(u, "GET", `/api/companies/C${String(i + 1).padStart(6, "0")}/tree`, "t");
    const e = entries(u).entries;
    expect(e).toHaveLength(200);
    for (let i = 1; i < e.length; i++) expect(e[i].seq).toBeGreaterThan(e[i - 1].seq);
    expect(e[e.length - 1].sql).toContain("C000080");
  });
});
