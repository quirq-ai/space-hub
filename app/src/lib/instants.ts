/**
 * An Instants library: a project with `instants.json` at its root, written by
 * Instants (github.com/quirq-ai/instants). Like chat.json makes a folder read
 * as a chat, the manifest makes the project's Files tab read as a feed of its
 * posts, the way Instants shows them; Code still shows the files.
 *
 *   instants.json                  the manifest, { "name", "version" }
 *   posts/<slug>.json              one post: slides, writeup, sources, topic, accent, dates
 *   media/<slug>/*                 images a post's slides use
 *   videos/<slug>.mp4, .jpg        a post's rendered video and its poster
 *   videos/<slug>.status.json      the render result
 *
 * Only the fields the feed shows are typed; a record without a post and its
 * slides is skipped, as Instants skips it.
 */
export const MANIFEST = "instants.json";
export const POSTS = "posts";
export const VIDEOS = "videos";

export type Slide = { type: string; [field: string]: unknown };
export type Source = { id: string; path: string; note?: string };
export type Post = {
  slug: string;
  title: string;
  kind: string;
  topic: string;
  status: string;
  hook: string;
  summary: string;
  writeup: string;
  tags: string[];
  accent: string;
  sources: Source[];
  slides: Slide[];
  /** When the research happened (its last commit), and when Instants wrote the post. */
  occurredAt: string;
  generatedAt: string;
  git: { commits: number; first: string; last: string } | null;
};

const text = (value: unknown) => typeof value === "string" ? value : "";

/** Whether a folder listing is an Instants library's root. */
export function isLibrary(entries: { name: string; kind: string; path: string }[]): boolean {
  return entries.some(entry => entry.kind === "file" && entry.path === MANIFEST);
}

/** The post a `posts/<slug>.json` record holds, or none when it is not one. */
export function parsePost(data: unknown, fallbackSlug = ""): Post | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const post = record.post as Record<string, unknown> | undefined;
  if (!post || typeof post !== "object" || !Array.isArray(post.slides)) return null;
  const slides = (post.slides as unknown[]).filter((slide): slide is Slide => !!slide && typeof slide === "object" && typeof (slide as Slide).type === "string");
  if (!slides.length) return null;
  const meta = record.meta as { git?: { commits?: number; first?: string; last?: string } } | undefined;
  const git = meta?.git && typeof meta.git.commits === "number" ? { commits: meta.git.commits, first: text(meta.git.first), last: text(meta.git.last) } : null;
  return {
    slug: text(record.slug) || fallbackSlug,
    title: text(post.title) || text(record.name) || fallbackSlug,
    kind: text(post.kind), topic: text(post.topic) || "Other", status: text(post.status),
    hook: text(post.hook), summary: text(post.summary), writeup: text(post.writeup),
    tags: Array.isArray(post.tags) ? post.tags.filter((tag): tag is string => typeof tag === "string") : [],
    accent: /^#[0-9a-f]{3,8}$/i.test(text(post.accent)) ? text(post.accent) : "#6b7280",
    sources: Array.isArray(post.sources) ? (post.sources as Source[]).filter(source => source && typeof source.id === "string") : [],
    slides,
    occurredAt: text(record.occurredAt), generatedAt: text(record.generatedAt), git,
  };
}

/** A slug from a post's path: posts/euler.json is euler. */
export function slugOf(path: string): string {
  return path.split("/").pop()!.replace(/\.json$/i, "");
}

/** Whether a path is a post record of a library. */
export function isPostPath(path: string): boolean {
  return /^posts\/[^/]+\.json$/i.test(path);
}

/**
 * The project path of a media link Instants writes: it serves the library
 * under /research, so /research/media/euler/1.jpg is media/euler/1.jpg.
 */
export function mediaPath(url: unknown): string {
  const value = text(url);
  if (!value || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) return "";
  return value.replace(/^\/+/, "").replace(/^research\//, "");
}

/** Newest research first, then the newest written. */
export function latestFirst(posts: Post[]): Post[] {
  const time = (iso: string) => Date.parse(iso) || 0;
  return [...posts].sort((a, b) => time(b.occurredAt) - time(a.occurredAt) || time(b.generatedAt) - time(a.generatedAt) || a.slug.localeCompare(b.slug));
}

/** A stable shuffle for Rediscover: the same order all day, a new one tomorrow. */
export function rediscover(posts: Post[], day = new Date().toISOString().slice(0, 10)): Post[] {
  const hash = (value: string) => { let h = 2166136261; for (const c of day + value) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  return [...posts].sort((a, b) => hash(a.slug) - hash(b.slug) || a.slug.localeCompare(b.slug));
}

/** The topics posts are filed under, sorted, Other last. */
export function topicsOf(posts: Post[]): string[] {
  return [...new Set(posts.map(post => post.topic))].sort((a, b) => (a === "Other" ? 1 : 0) - (b === "Other" ? 1 : 0) || a.localeCompare(b));
}

/** Whether a post matches a search: its title, hook, summary, topic, kind or tags. */
export function matches(post: Post, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [post.title, post.hook, post.summary, post.topic, post.kind, post.slug, ...post.tags].join(" ").toLowerCase();
  return words.every(word => hay.includes(word.replace(/^#/, "")));
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Developer Tools · Tool · research from Nov 2026", as Instants heads a card. */
export function byline(post: Post): string {
  const when = Date.parse(post.generatedAt || post.occurredAt);
  return [post.topic, post.kind, Number.isFinite(when) ? `research from ${MONTH.format(when)}` : ""].filter(Boolean).join(" · ");
}

/** "Oct 22 to Nov 6, 2026 · 74 commits", or empty without git history. */
export function span(post: Post): string {
  if (!post.git) return "";
  const first = Date.parse(post.git.first), last = Date.parse(post.git.last);
  const commits = `${post.git.commits} ${post.git.commits === 1 ? "commit" : "commits"}`;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return commits;
  const sameDay = DAY_YEAR.format(first) === DAY_YEAR.format(last);
  const sameYear = new Date(first).getUTCFullYear() === new Date(last).getUTCFullYear();
  const range = sameDay ? DAY_YEAR.format(last) : `${sameYear ? DAY.format(first) : DAY_YEAR.format(first)} to ${DAY_YEAR.format(last)}`;
  return `${range} · ${commits}`;
}

/** The accent's hue, for the dark tinted slide backgrounds Instants draws. */
export function hueOf(accent: string): number {
  let hex = accent.replace("#", "");
  if (hex.length === 3) hex = [...hex].map(c => c + c).join("");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  if ([r, g, b].some(Number.isNaN)) return 220;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 220;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round(((h * 60) + 360) % 360);
}
