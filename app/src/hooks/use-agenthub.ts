import { useCallback, useEffect, useRef, useState } from "react";
import { toEvents, type TaskEvent } from "@/lib/agenthub";

/**
 * A session's events, read from the start once and then only the new ones
 * (?after=), every few seconds while the agent works and the tab is visible.
 * A finished session is read once more, so its last events show.
 */
export function useTaskEvents(id: string, running: boolean, every = 2500) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState("");
  const next = useRef(0);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  // A different session starts from nothing.
  useEffect(() => { setEvents([]); setError(""); next.current = 0; }, [id]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      clearTimeout(timer);
      if (document.hidden) { timer = setTimeout(read, every); return; }
      try {
        const after = next.current;
        const response = await fetch(`/-/api/agenthub/tasks/${encodeURIComponent(id)}/events?after=${after}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "The events could not be loaded.");
        const page = toEvents(data, after);
        next.current = page.next;
        if (page.events.length) setEvents(old => [...old, ...page.events]);
        setError("");
        // A long history comes in pages: keep reading while there is more.
        if (page.events.length && page.next > after) { timer = setTimeout(read, 0); return; }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "The events could not be loaded.");
      }
      if (running && !controller.signal.aborted) timer = setTimeout(read, every);
    };
    void read();
    const wake = () => { if (!document.hidden && running) void read(); };
    document.addEventListener("visibilitychange", wake);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [id, running, every, revision]);

  return { events, error, refresh };
}
