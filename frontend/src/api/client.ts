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

/** The response when it is OK, or an ApiError. */
async function send(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal }, accept: string): Promise<Response> {
  // The tab's id lets the backend's Exasol console show this tab its own statements (Explain mode).
  const headers: Record<string, string> = { Accept: accept, "X-Credora-Session": consoleSession() };
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
  return res;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await send(path, init, "application/json");
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Calls onLine with each complete line as it arrives. A character split across two chunks stays whole. */
export async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let held = "";
  for (;;) {
    const { done, value } = await reader.read();
    held += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = held.split("\n");
    held = done ? "" : lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
    if (done) return;
  }
}

/** POST, then hand over each JSON event of the response as it arrives. */
export async function apiStream<E>(path: string, body: unknown, onEvent: (event: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await send(path, { method: "POST", body, signal }, "application/x-ndjson");
  if (!res.body) throw new ApiError(0, "The Credora API sent an empty answer. Try again.");
  try {
    await readLines(res.body, (line) => onEvent(JSON.parse(line) as E));
  } catch (e) {
    if ((e as Error).name === "AbortError" || e instanceof ApiError) throw e;
    throw new ApiError(0, "The connection dropped while the answer was coming. Try again.");
  }
}

/** Accepts either a bare array or an `{items: [...]}` envelope. */
export function asList<T>(x: T[] | { items: T[] } | null | undefined): T[] {
  if (!x) return [];
  return Array.isArray(x) ? x : x.items ?? [];
}
