import { useEffect, useState } from "react";
import { instanceRequest } from "@/lib/instance-recovery";

export function useInstanceRecovery<T>(path: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ path: string; data?: T; error: string; loading: boolean }>({ path, error: "", loading: true });
  useEffect(() => {
    let closed = false, running = false;
    let controller: AbortController | undefined;
    setState(previous => ({ path, data: previous.path === path ? previous.data : undefined, error: "", loading: true }));
    const read = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 20_000);
      try {
        const data = await instanceRequest<T>(path, { signal: controller.signal });
        if (!closed) setState({ path, data, error: "", loading: false });
      } catch (error) {
        if (!closed) setState(previous => ({ path, data: previous.path === path ? previous.data : undefined, error: error instanceof Error && error.name !== "AbortError" ? error.message : "The full-instance recovery request timed out.", loading: false }));
      } finally { clearTimeout(timeout); running = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 15_000);
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { closed = true; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [path, revision]);
  return { data: state.path === path ? state.data : undefined, error: state.path === path ? state.error : "", loading: state.path !== path || state.loading, refresh: () => setRevision(value => value + 1) };
}
