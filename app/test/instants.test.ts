import { test } from "node:test";
import assert from "node:assert/strict";
import { byline, hueOf, isLibrary, isPostPath, latestFirst, matches, mediaPath, parsePost, rediscover, span, topicsOf } from "../src/lib/instants.ts";

const record = (slug: string, over: Record<string, unknown> = {}, post: Record<string, unknown> = {}) => ({
  slug, occurredAt: "2026-11-04T13:29:10.000Z", generatedAt: "2026-11-06T17:14:41.671Z",
  meta: { git: { commits: 22, first: "2026-10-26T06:34:21.000Z", last: "2026-11-04T13:29:10.000Z" } },
  post: { title: `Post ${slug}`, kind: "Prototype", topic: "AI & Agents", status: "working", hook: "h", summary: "s", writeup: "w", tags: ["agents"], accent: "#83d63a", sources: [{ id: "s1", path: "README.md" }], slides: [{ type: "cover", heading: "Hi" }], ...post },
  ...over,
});

test("a library is a project with instants.json at its root, and only there", () => {
  assert.equal(isLibrary([{ name: "instants.json", kind: "file", path: "instants.json" }, { name: "posts", kind: "directory", path: "posts" }]), true);
  assert.equal(isLibrary([{ name: "instants.json", kind: "file", path: "sub/instants.json" }]), false);
  assert.equal(isLibrary([{ name: "chat.json", kind: "file", path: "chat.json" }]), false);
  assert.equal(isPostPath("posts/euler.json"), true);
  assert.equal(isPostPath("posts/deep/euler.json"), false);
  assert.equal(isPostPath("hidden/euler.json"), false);
});

test("posts parse from Instants records; anything without slides is skipped", () => {
  const post = parsePost(record("xo-agents"))!;
  assert.equal(post.title, "Post xo-agents");
  assert.deepEqual(post.git, { commits: 22, first: "2026-10-26T06:34:21.000Z", last: "2026-11-04T13:29:10.000Z" });
  assert.equal(parsePost({ slug: "x", post: { title: "t" } }), null);
  assert.equal(parsePost({ slug: "x", post: { slides: [] } }), null);
  assert.equal(parsePost(null), null);
  assert.equal(parsePost(record("bad", {}, { accent: "red; background:url(x)" }))!.accent, "#6b7280");
  assert.equal(parsePost(record("t", {}, { topic: "" }))!.topic, "Other");
});

test("media links Instants serves under /research map to project paths", () => {
  assert.equal(mediaPath("/research/media/euler/4.jpg"), "media/euler/4.jpg");
  assert.equal(mediaPath("media/euler/4.jpg"), "media/euler/4.jpg");
  assert.equal(mediaPath("https://example.com/a.png"), "");
  assert.equal(mediaPath(undefined), "");
});

test("bylines and spans read like Instants' card heads", () => {
  const post = parsePost(record("xo-agents"))!;
  assert.equal(byline(post), "AI & Agents · Prototype · research from Nov 2026");
  // When the research happened, not when Instants wrote it up.
  assert.equal(byline(parsePost(record("old", { occurredAt: "2026-05-20T00:00:00.000Z" }))!), "AI & Agents · Prototype · research from May 2026");
  assert.equal(span(post), "Oct 26 to Nov 4, 2026 · 22 commits");
  assert.equal(span(parsePost(record("n", { meta: {} }))!), "");
});

test("latest sorts by research date; rediscover is stable for a day; topics put Other last", () => {
  const a = parsePost(record("a", { occurredAt: "2026-10-01T00:00:00Z" }))!;
  const b = parsePost(record("b", { occurredAt: "2026-11-01T00:00:00Z" }, { topic: "Other" }))!;
  const c = parsePost(record("c", { occurredAt: "2026-09-01T00:00:00Z" }, { topic: "Business & Strategy" }))!;
  assert.deepEqual(latestFirst([a, b, c]).map(p => p.slug), ["b", "a", "c"]);
  assert.deepEqual(rediscover([a, b, c], "2026-11-06").map(p => p.slug), rediscover([c, a, b], "2026-11-06").map(p => p.slug));
  assert.deepEqual(topicsOf([a, b, c]), ["AI & Agents", "Business & Strategy", "Other"]);
  assert.equal(matches(a, "#agents post"), true);
  assert.equal(matches(a, "spacetime"), false);
});

test("accent hues", () => {
  assert.equal(hueOf("#ff0000"), 0);
  assert.equal(hueOf("#00ff00"), 120);
  assert.equal(hueOf("#888"), 220);
});
