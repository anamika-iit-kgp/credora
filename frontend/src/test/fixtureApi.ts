// Test helper: talk to the in-browser fixture server the way the app does, without the network and without waiting.
import { vi } from "vitest";
import type { Role } from "../api/types";
import { installFixtures, resetFixtures } from "../fixtures/server";

export interface Reply<T> {
  status: number;
  body: T;
}

/**
 * Installs the fixture fetch shim once, silences its log line and fakes setTimeout so that the shim's
 * artificial delay of up to 420 ms costs no real time. Call it in a top-level beforeAll.
 */
export function bootFixtures() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  installFixtures();
  log.mockRestore();
}

/** Back to the seed state that the fixtures start in (1,000 companies, the seeded book for RM001). */
export function freshFixtures() {
  resetFixtures();
}

/** One request with the given headers. */
export async function request<T = unknown>(headers: Record<string, string>, method: string, path: string, body?: unknown): Promise<Reply<T>> {
  const pending = window.fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  await vi.advanceTimersByTimeAsync(1000);
  const res = await pending;
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** One request as the given role, or as nobody when the role is null. */
export function call<T = unknown>(role: Role | null, method: string, path: string, body?: unknown): Promise<Reply<T>> {
  return request<T>(role ? { Authorization: `Bearer fx.${role}` } : {}, method, path, body);
}

export const get = <T = unknown>(role: Role | null, path: string) => call<T>(role, "GET", path);
export const post = <T = unknown>(role: Role | null, path: string, body?: unknown) => call<T>(role, "POST", path, body ?? {});

/** The detail text of an error reply. */
export const detail = (r: Reply<unknown>) => (r.body as { detail?: string } | null)?.detail ?? "";
