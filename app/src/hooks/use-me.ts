import { useEffect, useState } from "react";
import { useLive } from "./use-live";
import { viewUrl, type View, type SpaceMeta } from "@/api";

/** Who is signed in (checked by the web service), and the spaces they belong to. */
export function useMe() {
  const [me, setMe] = useState<{ name: string | null }>();
  useEffect(() => {
    void fetch("/-/api/me", { cache: "no-store" }).then(response => (response.ok ? response.json() : { name: null })).then(setMe).catch(() => setMe({ name: null }));
  }, []);
  const profile = useLive<View<SpaceMeta>>(me?.name ? viewUrl({ space: me.name, project: "" }) : undefined, 30_000);
  const spaces = me?.name ? [{ space: me.name, kind: "personal", role: "owner" }, ...(profile.data?.meta.memberOf ?? [])] : [];
  return { checked: !!me, name: me?.name ?? null, spaces };
}

const RECENT = "spacehub:recent:v1";

/** Projects opened recently in this browser, newest first. */
export function recentProjects(): string[] {
  try { const value = JSON.parse(localStorage.getItem(RECENT) || "[]"); return Array.isArray(value) ? value.filter(item => typeof item === "string").slice(0, 6) : []; } catch { return []; }
}

export function rememberProject(fullName: string) {
  try { localStorage.setItem(RECENT, JSON.stringify([fullName, ...recentProjects().filter(item => item !== fullName)].slice(0, 6))); } catch { /* Storage may be blocked. */ }
}
