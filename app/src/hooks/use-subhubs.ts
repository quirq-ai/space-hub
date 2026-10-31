import { useEffect, useState } from "react";
import { activityForProject, subhubRequest, subhubUrl, type SubhubActivity, type SubhubNode } from "@/lib/subhubs";

/** Independent of the Git view: an older or unavailable parent cannot break navigation. */
export function useSubhubResource<T>(url: string | undefined) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ url?: string; data?: T; error: string; loading: boolean }>({ error: "", loading: !!url });
  useEffect(() => {
    if (!url) return;
    let closed = false;
    let running = false;
    let controller: AbortController | undefined;
    setState(previous => ({ url, data: previous.url === url ? previous.data : undefined, error: "", loading: true }));
    const read = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 20_000);
      try {
        const data = await subhubRequest<T>(url, { signal: controller.signal });
        if (!closed) setState({ url, data, error: "", loading: false });
      } catch (error) {
        if (!closed) setState(previous => ({ url, data: previous.url === url ? previous.data : undefined, error: error instanceof Error && error.name !== "AbortError" ? error.message : "The sub-hub request timed out. Try again.", loading: false }));
      } finally { clearTimeout(timeout); running = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 15_000);
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { closed = true; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [url, revision]);
  return { data: state.url === url ? state.data : undefined, error: state.url === url ? state.error : "", loading: !!url && (state.url !== url || state.loading), refresh: () => setRevision(value => value + 1) };
}
export function useSubhubNodes(space?: string) { return useSubhubResource<{ nodes: SubhubNode[] }>(subhubUrl("/nodes", { space })); }
export function useSubhubActivity(space?: string, project?: string) {
  const resource = useSubhubResource<{ activity: SubhubActivity[] }>(subhubUrl("/activity", { space }));
  return { ...resource, items: activityForProject(resource.data?.activity ?? [], project) };
}
