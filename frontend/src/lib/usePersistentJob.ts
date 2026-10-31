import { useCallback, useState } from "react";

/** Remembers the last job of a kind for this browser tab, so its progress survives navigating away. */
export function usePersistentJob(kind: string): [string | null, (id: string | null) => void] {
  const key = `credora.job.${kind}`;
  const [id, setId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  });
  const set = useCallback(
    (v: string | null) => {
      setId(v);
      try {
        if (v) sessionStorage.setItem(key, v);
        else sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [id, set];
}
