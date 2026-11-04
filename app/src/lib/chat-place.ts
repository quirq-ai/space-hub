import type { Place } from "@/api";

/**
 * Where a place's one chat lives (module/src/index.ts chatOf agrees): an
 * org's at the root of <org>/chat, an agent's in its home project, a
 * project's in Chat/chat.json, or at the root of a project named chat.
 * Builders' own spaces have none.
 */
export function chatPlace(place: Place, kind = ""): { place: Place; path: string } | null {
  if (place.project) return { place, path: place.project === "chat" ? "chat.json" : "Chat/chat.json" };
  if (kind === "org") return { place: { space: place.space, project: "chat" }, path: "chat.json" };
  if (kind === "agent") return { place: { space: place.space, project: "home" }, path: "Chat/chat.json" };
  return null;
}
