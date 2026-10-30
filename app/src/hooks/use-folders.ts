import { useEffect, useState } from "react";
import { viewUrl, type Place, type View } from "@/api";
import { chatLogPath } from "@/lib/chat-log";
import { listsChannels } from "@/lib/channels";

export type FolderSummary = { items: number; channels: number };

const MAX_FOLDERS = 24;

/**
 * How much each folder holds, for the cards of the folder being looked at:
 * its channels when it lists channels, else its files and folders (a
 * conversation's log counts with its conversation, a README not at all).
 * Read once per listing; `revision` re-reads after a push.
 */
export function useFolderSummaries(place: Place, paths: string[], revision: string): Record<string, FolderSummary> {
  const key = paths.slice(0, MAX_FOLDERS).join("\n");
  const [state, setState] = useState<{ key: string; summaries: Record<string, FolderSummary> }>({ key: "", summaries: {} });
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const summaries: Record<string, FolderSummary> = {};
    void Promise.all(key.split("\n").map(async path => {
      try {
        const response = await fetch(viewUrl(place, path), { signal: controller.signal });
        if (!response.ok) return;
        const entries = ((await response.json()) as View).snapshot.directory.entries;
        const logs = new Set(entries.map(entry => chatLogPath(entry.path)).filter(Boolean));
        summaries[path] = {
          items: entries.filter(entry => !logs.has(entry.path) && !/^readme\.md$/i.test(entry.name)).length,
          channels: listsChannels(entries) ? entries.filter(entry => entry.kind === "directory").length : 0,
        };
      } catch { /* A folder that cannot be read keeps its card without a count. */ }
    })).then(() => { if (!controller.signal.aborted) setState({ key, summaries }); });
    return () => controller.abort();
  }, [key, revision, place.space, place.project]);
  return state.key === key ? state.summaries : {};
}
