import { useSyncExternalStore } from "react";
import type { Term } from "./glossary";

/** The glossary keyed by term id. The data file is large, so it is fetched on demand and kept after the first load. */
export type Glossary = Record<string, Term>;

let loaded: Glossary | null = null;
let pending: Promise<Glossary> | null = null;
const listeners = new Set<() => void>();

/** Fetches the term data once; later calls reuse the result. A failed fetch is forgotten, so the next call tries again. */
export function loadGlossary(): Promise<Glossary> {
  if (loaded) return Promise.resolve(loaded);
  pending ??= import("./glossary").then(
    (m) => {
      loaded = m.GLOSSARY;
      pending = null;
      listeners.forEach((notify) => notify());
      return m.GLOSSARY;
    },
    (err: unknown) => {
      pending = null;
      throw err;
    },
  );
  return pending;
}

/** Starts the fetch and ignores a failure: the term hints stay hidden, and the next click on one tries again. */
export function prefetchGlossary(): void {
  loadGlossary().catch(() => {});
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

const snapshot = () => loaded;

/** The glossary once it has loaded, otherwise null. Reading it never starts a fetch; call loadGlossary for that. */
export function useGlossary(): Glossary | null {
  return useSyncExternalStore(subscribe, snapshot);
}
