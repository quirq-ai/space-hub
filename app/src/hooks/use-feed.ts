import { useEffect, useState } from "react";
import { rawUrl, viewUrl, type Place, type View } from "@/api";
import { isPostPath, parsePost, POSTS, slugOf, VIDEOS, type Post } from "@/lib/instants";

export type Feed = { posts: Post[]; videos: Set<string>; total: number; loading: boolean; error: string };

const PARALLEL = 8;
// One read per library and commit, so going back from a post to the feed is instant.
const cache = new Map<string, Feed>();

async function listing(place: Place, path: string, signal: AbortSignal): Promise<string[]> {
  const response = await fetch(viewUrl(place, path), { signal });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Could not list ${path} (${response.status}).`);
  return ((await response.json()) as View).snapshot.directory.entries.filter(entry => entry.kind === "file").map(entry => entry.path);
}

/**
 * Every post of an Instants library, read from posts/*.json at `ref`, and
 * the slugs that have a rendered video. Posts arrive a batch at a time;
 * `revision` (the head commit) reads them again after a push.
 */
export function useFeed(place: Place, ref: string, revision: string): Feed {
  const key = `${place.space}/${place.project}@${revision}`;
  const [feed, setFeed] = useState<Feed>(() => cache.get(key) ?? { posts: [], videos: new Set(), total: 0, loading: true, error: "" });
  useEffect(() => {
    const done = cache.get(key);
    if (done) { setFeed(done); return; }
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const [postPaths, videoPaths] = await Promise.all([listing(place, POSTS, signal), listing(place, VIDEOS, signal).catch(() => [])]);
        const paths = postPaths.filter(isPostPath);
        const videos = new Set(videoPaths.filter(path => /\.mp4$/i.test(path)).map(path => path.split("/").pop()!.replace(/\.mp4$/i, "")));
        const posts: Post[] = [];
        let next = 0;
        const show = (loading: boolean) => { if (!signal.aborted) setFeed({ posts: [...posts], videos, total: paths.length, loading, error: "" }); };
        show(true);
        await Promise.all(Array.from({ length: Math.min(PARALLEL, paths.length) }, async () => {
          while (next < paths.length) {
            const path = paths[next++];
            try {
              const response = await fetch(rawUrl(place, ref, path), { signal });
              const post = response.ok ? parsePost(await response.json(), slugOf(path)) : null;
              if (post) posts.push(post);
            } catch (error) { if (signal.aborted) throw error; /* A broken record is skipped, as Instants skips it. */ }
            if (posts.length % 24 === 0) show(true);
          }
        }));
        const result = { posts, videos, total: paths.length, loading: false, error: "" };
        cache.set(key, result);
        if (!signal.aborted) setFeed(result);
      } catch (error) {
        if (!signal.aborted) setFeed(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
      }
    })();
    return () => controller.abort();
  }, [key, ref]);
  return feed;
}
