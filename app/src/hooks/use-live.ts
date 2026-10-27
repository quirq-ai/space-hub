import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

// Loads in flight that the reader is waiting for (not background re-checks):
// the progress bar at the top of the window follows this count.
let waiting = 0;
const listeners = new Set<() => void>();
function setWaiting(delta: number) { waiting += delta; listeners.forEach(listener => listener()); }
export function useLoading() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => waiting > 0);
}

export type Live<T> = { data: T | undefined; error: string; status: number; loading: boolean; refresh: () => void };

/**
 * A live read: loaded once, then re-checked every `every` ms while the tab is
 * visible (0: never), with an ETag so an unchanged answer costs one small
 * response. `url` undefined pauses it. The last answer for the same url stays
 * on screen while it is re-checked or when a re-check fails.
 */
export function useLive<T>(url: string | undefined, every = 1500): Live<T> {
  const [result, setResult] = useState<{ url: string; data: T }>();
  const [failure, setFailure] = useState<{ url: string; message: string; status: number }>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (url === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let etag = "";
    let pending = false;
    let first = true;
    setWaiting(1);
    const settleFirst = () => { if (first) { first = false; setWaiting(-1); } };
    const read = async () => {
      if (controller.signal.aborted || pending) return;
      clearTimeout(timer);
      if (document.hidden && !first) { timer = setTimeout(read, every || 1500); return; }
      pending = true;
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: etag ? { "If-None-Match": etag } : {} });
        if (response.status !== 304) {
          const data = await response.json();
          if (!response.ok) throw Object.assign(new Error(typeof data.error === "string" ? data.error : "This could not be loaded."), { status: response.status });
          etag = response.headers.get("ETag") || "";
          setResult({ url, data: data as T });
        }
        setFailure(undefined);
      } catch (error) {
        if (!controller.signal.aborted) setFailure({ url, message: error instanceof Error ? error.message : "This could not be loaded.", status: (error as { status?: number })?.status ?? 0 });
      } finally {
        pending = false;
        settleFirst();
        if (!controller.signal.aborted && every) timer = setTimeout(read, every);
      }
    };
    const wake = () => { if (!document.hidden) void read(); };
    void read();
    document.addEventListener("visibilitychange", wake);
    return () => { controller.abort(); clearTimeout(timer); settleFirst(); document.removeEventListener("visibilitychange", wake); };
  }, [url, revision, every]);
  const failed = failure && failure.url === url ? failure : undefined;
  const data = result && result.url === url ? result.data : undefined;
  return { data, error: failed?.message ?? "", status: failed?.status ?? 0, loading: url !== undefined && !data && !failed, refresh };
}
