// The one-click role switch lists the demo users from here, so each one must be a real role with a label.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "../api/types";
import { ROLE_LABEL } from "../lib/roles";

type Demo = typeof import("./demo");

/** Loads the module afresh, because lib/env.ts reads the fixture flag once when it is first imported. */
async function load(fixtures: boolean): Promise<Demo> {
  vi.resetModules();
  vi.stubEnv("VITE_USE_FIXTURES", fixtures ? "1" : "");
  return import("./demo");
}

const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("demo users in fixture mode", () => {
  it("are the four roles, in the order admin, data scientist, loan operations, relationship manager", async () => {
    const { fetchDemoUsers } = await load(true);
    const users = await fetchDemoUsers();
    expect(users.map((u) => u.username)).toEqual(["admin", "datasci", "loanops", "rm"]);
    for (const u of users) {
      expect(u.role).toBe(u.username);
      expect(u.password.length).toBeGreaterThan(0);
      expect(ROLE_LABEL[u.role]).toBeTruthy();
    }
  });

  it("need no network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { fetchDemoUsers } = await load(true);
    await fetchDemoUsers();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("demo users on a live deployment", () => {
  it("come from the server, each with the role its user name stands for", async () => {
    const spy = vi.fn(async () =>
      reply({
        users: [
          { username: "rm", password: "pw-rm" },
          { username: "admin", password: "pw-admin" },
        ],
      }),
    );
    vi.stubGlobal("fetch", spy);
    const { fetchDemoUsers } = await load(false);
    const users = await fetchDemoUsers();
    expect(users).toEqual([
      { username: "rm", password: "pw-rm", role: "rm" as Role },
      { username: "admin", password: "pw-admin", role: "admin" as Role },
    ]);
    expect(spy).toHaveBeenCalledWith("/api/auth/demo", expect.objectContaining({ headers: { Accept: "application/json" } }));
  });

  it("leave out unknown user names and users without a password", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply({
          users: [
            { username: "root", password: "pw" },
            { username: "datasci", password: "" },
            { username: "loanops", password: "pw-lo" },
          ],
        }),
      ),
    );
    const { fetchDemoUsers } = await load(false);
    expect(await fetchDemoUsers()).toEqual([{ username: "loanops", password: "pw-lo", role: "loanops" }]);
  });

  it("are empty when the deployment publishes no demo passwords", async () => {
    for (const answer of [reply({}, false), reply({ users: [] }), reply({})]) {
      vi.stubGlobal("fetch", vi.fn(async () => answer));
      const { fetchDemoUsers } = await load(false);
      expect(await fetchDemoUsers()).toEqual([]);
    }
  });

  it("are empty when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    const { fetchDemoUsers } = await load(false);
    expect(await fetchDemoUsers()).toEqual([]);
  });
});
