import type { ApiErrorBody } from "./types";
import { consoleSession, noteRequest } from "../explain/session";

const TOKEN_KEY = "credora.token";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: token lives only for this page */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  // The tab's id lets the backend's Exasol console show this tab its own statements (Explain mode).
  const headers: Record<string, string> = { Accept: "application/json", "X-Credora-Session": consoleSession() };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  noteRequest(method, path);

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "The Credora API cannot be reached. Check the connection and try again.");
  }

  if (res.status === 401 && !path.startsWith("/auth/login")) {
    setToken(null);
    unauthorizedListeners.forEach((fn) => fn());
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      if (body?.detail) message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Accepts either a bare array or an `{items: [...]}` envelope. */
export function asList<T>(x: T[] | { items: T[] } | null | undefined): T[] {
  if (!x) return [];
  return Array.isArray(x) ? x : x.items ?? [];
}
