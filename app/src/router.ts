import { useEffect, useState } from "react";
import type { Place } from "@/api";

/**
 * The app owns three paths (/, /<space>, /<space>/<project>); everything
 * inside a space or project lives in the hash, as "/<tab>?<params>", so the
 * server and its proxy only ever see those three paths.
 */
export type Route =
  | { page: "home"; tab?: "subhubs" }
  | { page: "space"; place: Place; tab: "projects" | "agents" | "activity" | "people" | "nodes" }
  // as=folder shows a folder as files even when it is a channel or a list of channels.
  | { page: "project"; place: Place; tab: "files"; path: string; as: string }
  | { page: "project"; place: Place; tab: "code"; ref: string; path: string }
  | { page: "project"; place: Place; tab: "commits"; ref: string; path: string; num: number }
  | { page: "project"; place: Place; tab: "commit"; oid: string }
  | { page: "project"; place: Place; tab: "deps" | "branches" | "activity" | "people" };

function decode(part: string) { try { return decodeURIComponent(part); } catch { return part; } }

export function parseRoute(pathname: string, hash: string): Route {
  const [space = "", project = ""] = pathname.split("/").filter(Boolean).map(decode);
  const place = { space, project };
  const [tab = "", qs = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(qs);
  if (!project && tab === "subhubs") return { page: "home", tab: "subhubs" };
  if (!space) return { page: "home" };
  if (!project) return { page: "space", place, tab: tab === "nodes" || tab === "activity" || tab === "people" || tab === "agents" ? tab : "projects" };
  switch (tab) {
    case "code": return { page: "project", place, tab: "code", ref: params.get("ref") ?? "", path: params.get("path") ?? "" };
    case "commits": return { page: "project", place, tab: "commits", ref: params.get("ref") ?? "", path: params.get("path") ?? "", num: Number(params.get("page") ?? 1) || 1 };
    case "commit": return { page: "project", place, tab: "commit", oid: params.get("oid") ?? "" };
    case "deps": case "branches": case "activity": case "people": return { page: "project", place, tab };
    default: return { page: "project", place, tab: "files", path: params.get("path") ?? "", as: params.get("as") ?? "" };
  }
}

/** The hash for a route inside a project or space. */
export function hashOf(tab: string, params: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "" && value !== 1) search.set(key, String(value));
  return "/" + tab + (search.size ? "?" + search : "");
}

const CHANGE = "spacehub:navigate";

/** Move without reloading: all three paths serve this same app. */
export function navigate(url: string) {
  const next = new URL(url, location.href);
  if (next.origin !== location.origin) { location.href = url; return; }
  if (next.pathname + next.hash === location.pathname + location.hash) return;
  history.pushState(null, "", next.pathname + next.search + next.hash);
  dispatchEvent(new Event(CHANGE));
}

export function useRoute(): Route {
  const read = () => parseRoute(location.pathname, location.hash);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    if (route.page === "home" && route.tab === "subhubs" && location.pathname !== "/") history.replaceState(null, "", "/#/subhubs");
  }, [route]);
  useEffect(() => {
    const update = () => setRoute(read());
    addEventListener("popstate", update);
    addEventListener("hashchange", update);
    addEventListener(CHANGE, update);
    return () => { removeEventListener("popstate", update); removeEventListener("hashchange", update); removeEventListener(CHANGE, update); };
  }, []);
  return route;
}

/** Same-origin app links navigate in place; modified clicks still open new tabs. */
export function onLink(event: React.MouseEvent<HTMLAnchorElement>) {
  const href = event.currentTarget.getAttribute("href");
  if (!href || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.currentTarget.target) return;
  const url = new URL(href, location.href);
  // Only the app's own pages: the hub, a space, a project.
  if (url.origin !== location.origin || url.pathname.split("/").filter(Boolean).length > 2 || url.pathname.startsWith("/-/") || url.search) return;
  event.preventDefault();
  navigate(url.pathname + url.hash);
}
