import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Clapperboard, Code2, ExternalLink, GalleryHorizontal, LayoutGrid, Search, X } from "lucide-react";
import { placeUrl, rawUrl, type Place, type ProjectMeta } from "@/api";
import { hashOf, navigate, onLink } from "@/router";
import { useFeed } from "@/hooks/use-feed";
import { byline, latestFirst, matches, rediscover, span, topicsOf, type Post } from "@/lib/instants";
import { Carousel } from "@/components/slides";
import { Markdown } from "@/components/content-view";
import { Empty, ErrorNote, Skeleton } from "@/ui/primitives";

const PAGE = 12;
const postHref = (place: Place, slug: string) => placeUrl(place, hashOf("files", { path: `posts/${slug}.json` }));
const codeHref = (place: Place, path = "") => placeUrl(place, hashOf("code", { path }));

/** The accent square Instants puts before a post's title. */
function Swatch({ accent, size = 32 }: { accent: string; size?: number }) {
  return <span className="feed-swatch" aria-hidden="true" style={{ width: size, height: size, background: `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 45%, transparent))` }} />;
}

function Tags({ tags }: { tags: string[] }) {
  return tags.length ? <div className="feed-tags">{tags.map(tag => <span key={tag}>#{tag}</span>)}</div> : null;
}

/** One post in the feed: its video or its slides, what it is, and the writeup on demand. */
function PostCard({ place, meta, post, video }: { place: Place; meta: ProjectMeta; post: Post; video: boolean }) {
  const raw = (path: string) => rawUrl(place, meta.defaultBranch, path);
  const [slides, setSlides] = useState(!video);
  const [more, setMore] = useState(false);
  const href = postHref(place, post.slug);
  const when = span(post);
  return <article className="feed-card">
    <header>
      <Swatch accent={post.accent} />
      <div>
        <div className="feed-title"><a href={href} onClick={onLink}>{post.title}</a>{video && <span className="feed-badge"><Clapperboard size={11} />Video</span>}</div>
        <div className="feed-byline">{byline(post)}</div>
        {when && <div className="feed-span mono">{when}</div>}
      </div>
    </header>
    {video && !slides
      ? <video className="feed-video" src={raw(`videos/${post.slug}.mp4`)} poster={raw(`videos/${post.slug}.jpg`)} controls playsInline preload="none" aria-label={`${post.title} video`} />
      : <Carousel post={post} raw={raw} />}
    <div className="feed-actions">
      {video && <button type="button" className="button ghost small" onClick={() => setSlides(!slides)}>{slides ? <><Clapperboard size={14} />Show video</> : <><GalleryHorizontal size={14} />Show slides</>}</button>}
      <a className="button ghost small" href={href} onClick={onLink}>Open post<ExternalLink size={13} /></a>
    </div>
    <div className="feed-text">
      <p>{post.summary || post.hook}</p>
      {post.writeup && <button type="button" className="feed-more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "Less" : "More from the writeup"}<ChevronDown size={14} /></button>}
      {more && <div className="feed-writeup"><Markdown content={post.writeup} filePath={`posts/${post.slug}.json`} navigate={path => navigate(placeUrl(place, hashOf("files", { path })))} /></div>}
      <Tags tags={post.tags} />
    </div>
  </article>;
}

function CardSkeleton() {
  return <div className="feed-card feed-skeleton">
    <header><Skeleton width={32} height={32} /><div><Skeleton width={220} height={14} /><Skeleton width={260} height={11} /></div></header>
    <div className="feed-skeleton-media" />
  </div>;
}

/**
 * An Instants library's Files tab: its posts as Instants' feed shows them,
 * newest first or shuffled, filtered by topic, videos or a search. The
 * library's files are under Code.
 */
export function FeedTab({ place, meta }: { place: Place; meta: ProjectMeta }) {
  const feed = useFeed(place, meta.defaultBranch, meta.head?.oid ?? "");
  const [order, setOrder] = useState<"latest" | "rediscover">("latest");
  const [onlyVideos, setOnlyVideos] = useState(false);
  const [topic, setTopic] = useState("");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const end = useRef<HTMLDivElement>(null);
  const sorted = useMemo(() => order === "latest" ? latestFirst(feed.posts) : rediscover(feed.posts), [feed.posts, order]);
  const topics = useMemo(() => topicsOf(feed.posts), [feed.posts]);
  const videos = feed.posts.filter(post => feed.videos.has(post.slug)).length;
  const posts = sorted.filter(post => (!onlyVideos || feed.videos.has(post.slug)) && (!topic || post.topic === topic) && matches(post, query));
  useEffect(() => setShown(PAGE), [order, onlyVideos, topic, query]);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setShown(n => n + PAGE); }, { rootMargin: "1200px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [posts.length > shown]);
  const ready = !feed.loading;
  return <div className="instants">
    <div className="feed-head">
      <div>
        <h2>Feed</h2>
        <p>{ready ? `${feed.posts.length} ${feed.posts.length === 1 ? "post" : "posts"}` : feed.total ? `Reading ${feed.posts.length} of ${feed.total} posts…` : "Reading posts…"}</p>
      </div>
      <a className="button ghost small" href={codeHref(place)} onClick={onLink} title="This library's files, in the Code tab"><Code2 size={14} />Files in Code</a>
    </div>
    <div className="feed-bar">
      <div className="feed-order" role="tablist">
        {(["latest", "rediscover"] as const).map(key => <button key={key} type="button" role="tab" aria-selected={order === key} className={order === key ? "on" : undefined} onClick={() => setOrder(key)}>{key === "latest" ? "Latest" : "Rediscover"}</button>)}
      </div>
      <label className="feed-search"><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a post or a topic" aria-label="Search posts" />{query && <button type="button" aria-label="Clear the search" onClick={() => setQuery("")}><X size={13} /></button>}</label>
      <div className="feed-kind">
        <button type="button" className={!onlyVideos ? "on" : undefined} onClick={() => setOnlyVideos(false)}><LayoutGrid size={14} />All posts</button>
        <button type="button" className={onlyVideos ? "on" : undefined} onClick={() => setOnlyVideos(true)}><Clapperboard size={14} />Videos{videos > 0 && <span>{videos}</span>}</button>
      </div>
    </div>
    {topics.length > 1 && <div className="feed-topics">
      <button type="button" className={!topic ? "on" : undefined} onClick={() => setTopic("")}>All</button>
      {topics.map(name => <button key={name} type="button" className={topic === name ? "on" : undefined} onClick={() => setTopic(topic === name ? "" : name)}>{name}</button>)}
    </div>}
    {feed.error && <ErrorNote message={feed.error} />}
    <div className="feed-list">
      {!ready && !posts.length ? <><CardSkeleton /><CardSkeleton /></>
        : posts.length ? posts.slice(0, shown).map(post => <PostCard key={post.slug} place={place} meta={meta} post={post} video={feed.videos.has(post.slug)} />)
        : ready && <Empty icon={<Search size={20} />} title={feed.posts.length ? "No posts match" : "No posts yet"}>
          <p>{feed.posts.length ? "Try another topic or search." : "Instants writes posts to posts/ as it turns sources into research."}</p>
        </Empty>}
      {posts.length > shown && <div ref={end} className="feed-end"><button type="button" className="button ghost" onClick={() => setShown(n => n + PAGE)}>Show more posts</button></div>}
    </div>
  </div>;
}

/** One post on its own page: slides, the full writeup, sources and tags. */
export function PostPage({ place, meta, post, path }: { place: Place; meta: ProjectMeta; post: Post; path: string }) {
  const [video, setVideo] = useState(true);
  const raw = (file: string) => rawUrl(place, meta.defaultBranch, file);
  const when = span(post);
  return <div className="post-page">
    <div className="post-nav">
      <a href={placeUrl(place, hashOf("files"))} onClick={onLink}><ArrowLeft size={14} />Feed</a>
      <a href={codeHref(place, path)} onClick={onLink}><Code2 size={14} />{path}</a>
    </div>
    <header className="post-head">
      <Swatch accent={post.accent} size={40} />
      <div>
        <h2>{post.title}</h2>
        <div className="feed-byline">{[byline(post), post.status].filter(Boolean).join(" · ")}</div>
        {when && <div className="feed-span mono">{when}</div>}
      </div>
    </header>
    <div className="post-grid">
      <div className="post-media">
        <Carousel post={post} raw={raw} />
        {/* Most posts have no video; one that does not load is left out. */}
        {video && <video key={post.slug} className="feed-video" src={raw(`videos/${post.slug}.mp4`)} poster={raw(`videos/${post.slug}.jpg`)} controls playsInline preload="metadata" onError={() => setVideo(false)} aria-label={`${post.title} video`} />}
      </div>
      <div className="post-text">
        {post.hook && <p className="post-hook">{post.hook}</p>}
        <div className="feed-writeup"><Markdown content={post.writeup || post.summary} filePath={path} navigate={next => navigate(placeUrl(place, hashOf("files", { path: next })))} /></div>
        {post.sources.length > 0 && <>
          <h3 className="section-title">Sources</h3>
          <ol className="post-sources">{post.sources.map(source => <li key={source.id}><span className="mono">{source.id}</span><div><strong>{source.path}</strong>{source.note && <span>{source.note}</span>}</div></li>)}</ol>
        </>}
        <Tags tags={post.tags} />
      </div>
    </div>
  </div>;
}
