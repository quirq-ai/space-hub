import { useCallback, useEffect, useState } from "react";
import { viewUrl, type Place, type View } from "@/api";

/**
 * A live read of the hub: re-checked every 1.5 seconds while the tab is
 * visible, with an ETag so an unchanged view costs one small response.
 * `path` undefined pauses it.
 */
export function useView(place: Place, path: string | undefined) {
  const key = path === undefined ? undefined : viewUrl(place, path);
  const [result, setResult] = useState<{ key: string; view: View }>();
  const [failure, setFailure] = useState<{ key: string; message: string; status: number }>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (key === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let etag = "";
    let pending = false;
    const read = async () => {
      if (controller.signal.aborted || pending) return;
      clearTimeout(timer);
      if (document.hidden) { timer = setTimeout(read, 1500); return; }
      pending = true;
      try {
        const response = await fetch(key, { cache: "no-store", signal: controller.signal, headers: etag ? { "If-None-Match": etag } : {} });
        if (response.status !== 304) {
          const data = await response.json();
          if (!response.ok) throw Object.assign(new Error(typeof data.error === "string" ? data.error : "This could not be read."), { status: response.status });
          etag = response.headers.get("ETag") || "";
          setResult({ key, view: data as View });
        }
        setFailure(undefined);
      } catch (error) {
        if (!controller.signal.aborted) setFailure({ key, message: error instanceof Error ? error.message : "This could not be read.", status: (error as { status?: number })?.status ?? 0 });
      } finally {
        pending = false;
        if (!controller.signal.aborted) timer = setTimeout(read, 1500);
      }
    };
    const wake = () => { if (!document.hidden) void read(); };
    void read();
    document.addEventListener("visibilitychange", wake);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [key, revision]);
  const failed = failure && failure.key === key ? failure : undefined;
  return { view: result && result.key === key ? result.view : undefined, error: failed?.message ?? "", missing: failed?.status === 404, refresh };
}
