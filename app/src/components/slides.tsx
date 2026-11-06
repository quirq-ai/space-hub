import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Circle } from "lucide-react";
import { hueOf, mediaPath, type Post, type Slide } from "@/lib/instants";

/**
 * A post's slides as Instants draws them: 4:5 cards on a dark ground tinted
 * by the post's accent, sized by the card's width (cqw) so the same slide
 * reads the same in a feed card and on the post page.
 */
type Raw = (path: string) => string;

const str = (value: unknown) => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const list = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

function palette(accent: string) {
  const hue = hueOf(accent);
  return {
    hue,
    ground: `radial-gradient(120% 70% at 100% 0%, hsl(${hue} 36% 13%) 0%, hsl(${hue} 40% 8%) 60%)`,
    ink: `hsl(${hue} 12% 96%)`,
    soft: `hsl(${hue} 10% 72%)`,
    faint: `hsl(${hue} 10% 52%)`,
    line: `hsl(${hue} 20% 22%)`,
    glow: `hsl(${hue} 66% 60%)`,
    panel: `hsl(${hue} 30% 12%)`,
  };
}

const SERIES = (hue: number) => [`hsl(${hue} 66% 60%)`, `hsl(${(hue + 150) % 360} 55% 62%)`, `hsl(${(hue + 230) % 360} 50% 66%)`];

function Chart({ slide, hue }: { slide: Slide; hue: number }) {
  const x = list<string>(slide.x).map(str);
  const series = list<{ name: string; values: number[] }>(slide.series).filter(s => Array.isArray(s?.values));
  const colors = SERIES(hue);
  const kind = str(slide.chart);
  if (!x.length || !series.length) return null;
  if (kind === "donut") {
    const values = series[0].values.map(v => Math.max(0, Number(v) || 0));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    let at = 0;
    const tones = values.map((_, i) => `hsl(${(hue + i * 47) % 360} 58% ${62 - (i % 3) * 8}%)`);
    return <div className="slide-donut">
      <svg viewBox="0 0 100 100" aria-hidden="true">{values.map((v, i) => {
        const start = at / total, end = (at += v) / total;
        const large = end - start > .5 ? 1 : 0;
        const p = (t: number) => [50 + 40 * Math.sin(t * 2 * Math.PI), 50 - 40 * Math.cos(t * 2 * Math.PI)];
        const [x1, y1] = p(start), [x2, y2] = p(Math.min(end, start + .9999));
        return <path key={i} d={`M ${x1} ${y1} A 40 40 0 ${large} 1 ${x2} ${y2}`} fill="none" stroke={tones[i]} strokeWidth="16" />;
      })}</svg>
      <ul>{x.map((label, i) => <li key={i}><i style={{ background: tones[i] }} />{label}<b>{values[i]}{str(slide.unit) && ` ${str(slide.unit)}`}</b></li>)}</ul>
    </div>;
  }
  const stacked = kind === "stackedBar";
  const totals = x.map((_, i) => series.reduce((sum, s) => sum + Math.max(0, Number(s.values[i]) || 0), 0));
  const max = Math.max(1, ...(stacked ? totals : series.flatMap(s => s.values.map(v => Number(v) || 0))));
  const W = 300, H = 170, top = 14, left = 4, plotH = H - top - 26;
  const step = (W - left * 2) / x.length;
  const y = (v: number) => top + plotH - (Math.max(0, v) / max) * plotH;
  return <div className="slide-chart">
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <line x1={left} x2={W - left} y1={top + plotH} y2={top + plotH} stroke="currentColor" strokeOpacity=".25" />
      {kind === "line" ? series.map((s, k) => {
        const points = x.map((_, i) => `${left + step * (i + .5)},${y(Number(s.values[i]) || 0)}`);
        return <g key={k}><polyline points={points.join(" ")} fill="none" stroke={colors[k % 3]} strokeWidth="2.5" strokeLinejoin="round" />
          {points.map((pt, i) => { const [cx, cy] = pt.split(",").map(Number); return <circle key={i} cx={cx} cy={cy} r="3" fill={colors[k % 3]} />; })}</g>;
      }) : x.map((_, i) => {
        if (stacked) {
          let base = 0;
          return <g key={i}>{series.map((s, k) => { const v = Math.max(0, Number(s.values[i]) || 0); const y0 = y(base), y1 = y(base += v); return <rect key={k} x={left + step * i + step * .18} width={step * .64} y={y1} height={Math.max(0, y0 - y1)} fill={colors[k % 3]} rx="2" />; })}</g>;
        }
        const w = (step * .7) / series.length;
        return <g key={i}>{series.map((s, k) => { const v = Number(s.values[i]) || 0; return <g key={k}>
          <rect x={left + step * i + step * .15 + w * k} width={w - 2} y={y(v)} height={top + plotH - y(v)} fill={colors[k % 3]} rx="2" />
          {series.length === 1 && <text x={left + step * i + step * .15 + w / 2} y={y(v) - 4} textAnchor="middle" fontSize="9" fill="currentColor">{v}</text>}
        </g>; })}</g>;
      })}
      {x.map((label, i) => <text key={i} x={left + step * (i + .5)} y={H - 8} textAnchor="middle" fontSize="8.5" fill="currentColor" fillOpacity=".7">{label.length > 14 ? label.slice(0, 13) + "…" : label}</text>)}
    </svg>
    {series.length > 1 && <ul className="slide-legend">{series.map((s, k) => <li key={k}><i style={{ background: colors[k % 3] }} />{s.name}</li>)}</ul>}
  </div>;
}

function Body({ slide, raw, hue, title }: { slide: Slide; raw: Raw; hue: number; title: string }): ReactNode {
  const heading = str(slide.heading);
  const h = heading ? <h3 className="slide-heading">{heading}</h3> : null;
  switch (slide.type) {
    case "cover": {
      const image = mediaPath(slide.image);
      return <>
        {image && <img className="slide-cover-image" src={raw(image)} alt="" loading="lazy" decoding="async" />}
        <div className="slide-cover">
          <h2>{heading || title}</h2>
          {str(slide.body) && <p>{str(slide.body)}</p>}
        </div>
      </>;
    }
    case "takeaway":
      return <div className="slide-takeaway"><span className="slide-kicker">Takeaway</span><h2>{heading}</h2>{str(slide.body) && <p>{str(slide.body)}</p>}</div>;
    case "quote":
      return <figure className="slide-quote"><blockquote>{str(slide.text)}</blockquote>{str(slide.attribution) && <figcaption>{str(slide.attribution)}</figcaption>}</figure>;
    case "image": {
      const image = mediaPath(slide.image);
      return <>{h}<div className={`slide-image${str(slide.fit) === "contain" ? " contain" : ""}`}>{image && <img src={raw(image)} alt={str(slide.caption)} loading="lazy" decoding="async" />}</div>{str(slide.caption) && <p className="slide-caption">{str(slide.caption)}</p>}</>;
    }
    case "table": {
      const rows = list<unknown[]>(slide.rows);
      const highlight = typeof slide.highlight === "number" ? slide.highlight : -1;
      return <>{h}<div className="slide-table"><table>
        <thead><tr>{list<string>(slide.columns).map((c, i) => <th key={i}>{str(c)}</th>)}</tr></thead>
        <tbody>{rows.slice(0, 8).map((row, i) => <tr key={i} className={i === highlight ? "on" : undefined}>{list<unknown>(row).map((cell, j) => <td key={j}>{str(cell)}</td>)}</tr>)}</tbody>
      </table></div></>;
    }
    case "bigNumbers":
      return <>{h}<div className="slide-numbers">{list<{ value: unknown; label: unknown }>(slide.items).slice(0, 4).map((item, i) => <div key={i}><b>{str(item?.value)}</b><span>{str(item?.label)}</span></div>)}</div></>;
    case "compare": {
      const side = (value: unknown, cls: string) => { const s = (value ?? {}) as { title?: string; points?: string[] }; return <div className={cls}><h4>{str(s.title)}</h4><ul>{list<string>(s.points).map((p, i) => <li key={i}>{str(p)}</li>)}</ul></div>; };
      return <>{h}<div className="slide-compare">{side(slide.left, "left")}{side(slide.right, "right")}</div></>;
    }
    case "code":
      return <>{h}<pre className="slide-code" data-lang={str(slide.lang)}><code>{str(slide.code)}</code></pre>{str(slide.caption) && <p className="slide-caption">{str(slide.caption)}</p>}</>;
    case "timeline":
      return <>{h}<ol className="slide-timeline">{list<{ date: unknown; label: unknown }>(slide.events).slice(0, 7).map((e, i) => <li key={i}><time>{str(e?.date)}</time><span>{str(e?.label)}</span></li>)}</ol></>;
    case "flow":
      return <>{h}<ol className="slide-flow">{list<{ label: unknown; detail: unknown }>(slide.steps).slice(0, 6).map((s, i) => <li key={i}><b>{i + 1}</b><div><strong>{str(s?.label)}</strong>{str(s?.detail) && <span>{str(s?.detail)}</span>}</div></li>)}</ol></>;
    case "checklist":
      return <>{h}<ul className="slide-checklist">{list<{ text: unknown; done: unknown }>(slide.items).slice(0, 8).map((item, i) => <li key={i} className={item?.done ? "done" : undefined}>{item?.done ? <Check size={14} /> : <Circle size={14} />}<span>{str(item?.text)}</span></li>)}</ul></>;
    case "chart":
      return <>{h}<Chart slide={slide} hue={hue} />{str(slide.takeaway) && <p className="slide-caption">{str(slide.takeaway)}</p>}</>;
    default:
      return <>{h}{str(slide.body) && <p>{str(slide.body)}</p>}</>;
  }
}

const SECTION: Record<string, string> = { table: "Table", bigNumbers: "Numbers", compare: "Compare", code: "Code", timeline: "Timeline", flow: "Flow", checklist: "Checklist", chart: "Chart", quote: "Quote", image: "Figure", takeaway: "Takeaway" };

/** One slide, drawn at the width it is given. */
export function SlideCard({ post, slide, index, raw }: { post: Post; slide: Slide; index: number; raw: Raw }) {
  const colors = palette(post.accent);
  const source = post.sources.find(s => s.id === slide.src);
  const style = { "--slide-ground": colors.ground, "--slide-ink": colors.ink, "--slide-soft": colors.soft, "--slide-faint": colors.faint, "--slide-line": colors.line, "--slide-glow": colors.glow, "--slide-panel": colors.panel } as CSSProperties;
  const cover = slide.type === "cover";
  return <div className="slide-frame"><div className={`slide slide-${slide.type}-card`} style={style}>
    {cover && <svg className="slide-rings" viewBox="0 0 1080 1350" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {[70, 132, 194, 256, 318, 380, 442].map((r, i) => <circle key={r} cx="840" cy="260" r={r} fill="none" stroke={colors.glow} strokeOpacity={.22 - i * .02} strokeWidth="2" />)}
    </svg>}
    {!cover && SECTION[slide.type] && <span className="slide-section">{SECTION[slide.type]}</span>}
    <div className="slide-body"><Body slide={slide} raw={raw} hue={colors.hue} title={post.title} /></div>
    <footer className="slide-foot">
      <span>{cover ? post.title : source ? `Source: ${source.path}` : post.title}</span>
      <span className="mono">{String(index + 1).padStart(2, "0")}/{String(post.slides.length).padStart(2, "0")}</span>
    </footer>
  </div></div>;
}

/** A post's slides, swiped or stepped through, with a bar of where you are. */
export function Carousel({ post, raw, onFirst }: { post: Post; raw: Raw; onFirst?: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const total = post.slides.length;
  const go = useCallback((index: number) => {
    const el = track.current;
    if (!el) return;
    const next = Math.max(0, Math.min(total - 1, index));
    el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" });
  }, [total]);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const update = () => setAt(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, []);
  useEffect(() => { if (at > 0) onFirst?.(); }, [at, onFirst]);
  return <section className="carousel" aria-roledescription="carousel" aria-label={`${post.title} slides`} tabIndex={0}
    onKeyDown={event => { if (event.key === "ArrowRight") { event.preventDefault(); go(at + 1); } if (event.key === "ArrowLeft") { event.preventDefault(); go(at - 1); } }}>
    <div className="carousel-track" ref={track}>
      {post.slides.map((slide, i) => <div key={i} className="carousel-slide" role="group" aria-roledescription="slide" aria-label={`Slide ${i + 1} of ${total}`}>
        {Math.abs(i - at) <= 1 ? <SlideCard post={post} slide={slide} index={i} raw={raw} /> : <div className="slide-frame"><div className="slide" style={{ background: palette(post.accent).ground }} /></div>}
      </div>)}
    </div>
    {at > 0 && <button type="button" className="carousel-step prev" aria-label="Previous slide" onClick={() => go(at - 1)}><ChevronLeft size={18} /></button>}
    {at < total - 1 && <button type="button" className="carousel-step next" aria-label="Next slide" onClick={() => go(at + 1)}><ChevronRight size={18} /></button>}
    <div className="carousel-bar">
      {post.slides.map((_, i) => <button key={i} type="button" className={i <= at ? "on" : undefined} aria-label={`Go to slide ${i + 1}`} onClick={() => go(i)} />)}
      <span className="mono">{at + 1}/{total}</span>
    </div>
  </section>;
}
