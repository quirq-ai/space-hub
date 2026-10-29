import { createContext, useContext, useEffect, useState } from "react";
import { viewUrl, type Place, type View } from "@/api";
import { parseChatLog } from "@/lib/chat-log";
import { listsChannels, type LastTurn } from "@/lib/channels";
import type { Entry } from "@/lib/types";
import { useLive } from "./use-live";

export type Channels = { root: string; entries: Entry[]; last: Record<string, LastTurn | undefined> };

const MAX_CHANNELS = 40;
const SEEN = "spacehub:seen:v1";

/** When the viewer last looked at each channel of a project, by channel path (kept with the app's other "seen" times). */
export function seenChannels(place: Place): Record<string, string> {
  const prefix = `${place.space}/${place.project}:`;
  let all: Record<string, string> = {};
  try { all = JSON.parse(localStorage.getItem(SEEN) || "{}") ?? {}; } catch { /* Storage may be blocked. */ }
  return Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith(prefix)).map(([key, at]) => [key.slice(prefix.length), at]));
}
export const channelSeenKey = (place: Place, path: string) => `${place.space}/${place.project}:${path}`;

/**
 * The channels of a project's Chat folder, with each one's newest turn from
 * its `chat.log.jsonl`, for the sidebar and the channel list. Logs are
 * re-checked every 10 seconds with an ETag each, so a quiet channel costs one
 * small answer. `root` undefined pauses it.
 */
export function useChannels(place: Place, root: string | undefined): Channels | undefined {
  const listing = useLive<View>(root !== undefined ? viewUrl(place, root) : undefined, 5000);
  const entries = listing.data && listing.data.snapshot.directory.path === root && listsChannels(listing.data.snapshot.directory.entries)
    ? listing.data.snapshot.directory.entries.filter(entry => entry.kind === "directory").slice(0, MAX_CHANNELS) : undefined;
  const key = entries?.map(entry => entry.path).join("\n") ?? "";
  const [last, setLast] = useState<{ key: string; turns: Record<string, LastTurn | undefined> }>({ key: "", turns: {} });

  useEffect(() => {
    if (!key) return;
    const paths = key.split("\n");
    const controller = new AbortController();
    const etags = new Map<string, string>();
    const turns: Record<string, LastTurn | undefined> = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (document.hidden) { timer = setTimeout(read, 10_000); return; }
      let changed = false;
      await Promise.all(paths.map(async path => {
        const url = viewUrl(place, `${path}/chat.log.jsonl`);
        try {
          const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: etags.has(url) ? { "If-None-Match": etags.get(url)! } : {} });
          if (response.status === 304) return;
          if (!response.ok) { etags.set(url, ""); return; }
          etags.set(url, response.headers.get("ETag") || "");
          const view = await response.json() as View;
          const turn = parseChatLog(view.snapshot.file?.content ?? "").at(-1);
          turns[path] = turn && { author: turn.author, role: turn.role, content: turn.content, time: turn.time };
          changed = true;
        } catch { /* A missing or unreadable log leaves the channel without a preview. */ }
      }));
      if (controller.signal.aborted) return;
      if (changed) setLast({ key, turns: { ...turns } });
      timer = setTimeout(read, 10_000);
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, place.space, place.project]);

  if (root === undefined || !entries) return;
  return { root, entries, last: last.key === key ? last.turns : {} };
}

/** The channels of the project being looked at, shared by the sidebar and the Chat folder. */
export const ChannelsContext = createContext<Channels | undefined>(undefined);
export const useChannelsHere = () => useContext(ChannelsContext);
