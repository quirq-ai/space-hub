import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Code2, File, FileText, Folder, GitBranch, GitCommitHorizontal, Link2, Tag } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkHtmlAsText } from "@/lib/markdown";
import { mediaOf } from "@/lib/media";
import { MarkdownMedia, RawFiles } from "@/components/content-view";
import { codeUrl, placeUrl, rawUrl, size, type CodeBlob, type CodeTree, type CommitDetail, type CommitSummary, type Commits, type Place, type Refs } from "@/api";
import { useLive } from "@/hooks/use-live";
import { hashOf, navigate, onLink } from "@/router";
import { Ago, Avatar, CopyButton, Empty, ErrorNote, Skeleton, SkeletonRows, SkeletonText } from "@/ui/primitives";

const href = (place: Place, tab: string, params: Record<string, string | number | undefined>) => placeUrl(place, hashOf(tab, params));

function RefPicker({ place, current, tab, path }: { place: Place; current: string; tab: "code" | "commits"; path: string }) {
  const refs = useLive<Refs>(codeUrl(place, "refs"), 10_000);
  const names = refs.data ? [...refs.data.branches, ...refs.data.tags] : [];
  return <label className="ref-picker"><GitBranch size={14} />
    <select aria-label="Branch or tag" value={current} onChange={event => navigate(href(place, tab, { ref: event.target.value, path }))}>
      {!names.some(ref => ref.name === current) && <option value={current}>{current.length === 40 ? current.slice(0, 7) : current}</option>}
      {refs.data?.branches.length ? <optgroup label="Branches">{refs.data.branches.map(ref => <option key={ref.name} value={ref.name}>{ref.name}</option>)}</optgroup> : null}
      {refs.data?.tags.length ? <optgroup label="Tags">{refs.data.tags.map(ref => <option key={ref.name} value={ref.name}>{ref.name}</option>)}</optgroup> : null}
    </select></label>;
}

function CommitLine({ place, commit, label }: { place: Place; commit: CommitSummary; label?: string }) {
  return <div className="commit-line">
    <Avatar name={commit.author} size={22} />
    <strong>{commit.author}</strong>
    <a className="commit-subject" href={href(place, "commit", { oid: commit.oid })} onClick={onLink}>{commit.subject || "(no message)"}</a>
    <span className="commit-right">{label}<a className="mono quiet" href={href(place, "commit", { oid: commit.oid })} onClick={onLink}>{commit.oid.slice(0, 7)}</a><Ago iso={commit.time} /></span>
  </div>;
}

function PathCrumbs({ place, ref, path }: { place: Place; ref: string; path: string }) {
  const parts = path.split("/").filter(Boolean);
  return <nav className="path-crumbs" aria-label="Path">
    <a href={href(place, "code", { ref })} onClick={onLink}>{place.project}</a>
    {parts.map((part, i) => <span key={i}><span className="crumb-sep">/</span>{i === parts.length - 1 ? <strong>{part}</strong> : <a href={href(place, "code", { ref, path: parts.slice(0, i + 1).join("/") })} onClick={onLink}>{part}</a>}</span>)}
  </nav>;
}

/** A file's Markdown, its images and video shown from this ref. */
function Doc({ text, filePath }: { text: string; filePath: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkHtmlAsText]} skipHtml components={{ img: ({ src, alt }) => <MarkdownMedia src={typeof src === "string" ? src : ""} alt={alt} filePath={filePath} /> }}>{text}</ReactMarkdown>;
}

function CodeLines({ text }: { text: string }) {
  const lines = useMemo(() => { const all = text.split("\n"); if (all.length > 1 && all[all.length - 1] === "") all.pop(); return all; }, [text]);
  const [selected, setSelected] = useState<number>();
  return <div className="code-box"><table className="code"><tbody>{lines.map((line, i) => <tr key={i} className={selected === i ? "selected" : undefined}>
    <td className="line-no"><button type="button" onClick={() => setSelected(i)} aria-label={`Line ${i + 1}`}>{i + 1}</button></td><td className="line">{line || " "}</td>
  </tr>)}</tbody></table></div>;
}

export function CodeTab({ place, ref, path, defaultBranch }: { place: Place; ref: string; path: string; defaultBranch: string }) {
  const current = ref || defaultBranch;
  const live = useLive<CodeTree | CodeBlob>(codeUrl(place, "tree", { ref: current, path }), 5000);
  const [markdown, setMarkdown] = useState(true);
  const data = live.data;
  const media = mediaOf(path);
  return <RawFiles.Provider value={file => rawUrl(place, current, file)}><div className="code-tab">
    <div className="toolbar"><RefPicker place={place} current={current} tab="code" path={path} /><PathCrumbs place={place} ref={current} path={path} />
      <span className="toolbar-spacer" />{path && <a className="button ghost" href={href(place, "commits", { ref: current, path })} onClick={onLink}><GitCommitHorizontal size={15} />History</a>}</div>
    {live.error && <ErrorNote message={live.error} retry={live.refresh} />}
    {!data && !live.error && <div className="panel"><div className="panel-head"><Skeleton width={260} /></div>{/\.[a-z0-9]+$/i.test(path) ? <SkeletonText lines={12} /> : <SkeletonRows rows={8} avatar={false} />}</div>}
    {data?.kind === "tree" && <>
      <div className="panel">
        {(data.last ?? data.commit) && <div className="panel-head"><CommitLine place={place} commit={data.last ?? data.commit} /></div>}
        {data.entries.length ? <table className="tree"><tbody>{data.entries.map(entry => {
          const child = path ? `${path}/${entry.name}` : entry.name;
          const Icon = entry.type === "tree" ? Folder : entry.type === "link" ? Link2 : entry.type === "commit" ? GitBranch : File;
          return <tr key={entry.name}>
            <td className="tree-name"><Icon size={16} className={entry.type === "tree" ? "folder-icon" : "file-icon"} />{entry.type === "commit" ? <span>{entry.name}</span> : <a href={href(place, "code", { ref: current, path: child })} onClick={onLink}>{entry.name}</a>}</td>
            <td className="tree-message">{entry.last && <a href={href(place, "commit", { oid: entry.last.oid })} onClick={onLink}>{entry.last.subject}</a>}</td>
            <td className="tree-time">{entry.last && <Ago iso={entry.last.time} />}</td>
          </tr>;
        })}</tbody></table> : <Empty icon={<Folder size={20} />} title="Empty folder" />}
      </div>
      {data.readme && <div className="panel readme"><div className="panel-head"><FileText size={15} /><strong>{data.readme.name}</strong></div>
        <div className="markdown">{/\.txt$/i.test(data.readme.name) ? <pre>{data.readme.content}</pre> : <Doc text={data.readme.content} filePath={path ? `${path}/${data.readme.name}` : data.readme.name} />}</div></div>}
    </>}
    {data?.kind === "blob" && <div className="panel">
      <div className="panel-head">
        {data.last ? <CommitLine place={place} commit={data.last} /> : <span className="quiet">{data.path}</span>}
      </div>
      <div className="panel-subhead"><span>{size(data.size)}</span>{!data.binary && data.text !== null && <span>{data.text.split("\n").length} lines</span>}<span className="toolbar-spacer" />
        {/\.(md|markdown)$/i.test(path) && <button type="button" className="button ghost small" onClick={() => setMarkdown(value => !value)}>{markdown ? "Source" : "Preview"}</button>}
        {data.text !== null && <CopyButton text={data.text} label="Copy contents" />}
        <a className="button ghost small" href={rawUrl(place, current, path)} target="_blank" rel="noreferrer">Raw</a></div>
      {media === "image" ? <div className="image-box"><img src={rawUrl(place, current, path)} alt={path} /></div>
        : media === "video" ? <div className="image-box"><video src={rawUrl(place, current, path)} controls preload="metadata" playsInline aria-label={path} /></div>
        : data.binary ? <Empty icon={<File size={20} />} title="Binary file"><p>It can't be shown as text. <a href={rawUrl(place, current, path)}>Download it</a>.</p></Empty>
        : data.text === null ? <Empty icon={<File size={20} />} title="Large file"><p>Over 1 MB. <a href={rawUrl(place, current, path)}>Open it raw</a>.</p></Empty>
        : /\.(md|markdown)$/i.test(path) && markdown ? <div className="markdown padded"><Doc text={data.text} filePath={path} /></div>
        : <CodeLines text={data.text} />}
    </div>}
  </div></RawFiles.Provider>;
}

function dayOf(iso: string) { return new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }); }

export function CommitsTab({ place, ref, path, num, defaultBranch }: { place: Place; ref: string; path: string; num: number; defaultBranch: string }) {
  const current = ref || defaultBranch;
  const live = useLive<Commits>(codeUrl(place, "commits", { ref: current, path, page: num }), 10_000);
  let lastDay = "";
  return <div className="code-tab">
    <div className="toolbar"><RefPicker place={place} current={current} tab="commits" path={path} /><span className="quiet">{path ? <>History of <strong>{path}</strong></> : "History"}</span></div>
    {live.error && <ErrorNote message={live.error} retry={live.refresh} />}
    {!live.data && !live.error && <SkeletonRows rows={10} />}
    {live.data && (live.data.commits.length ? <ol className="commit-list">{live.data.commits.map(commit => {
      const day = dayOf(commit.time);
      const header = day !== lastDay ? day : "";
      lastDay = day;
      return <li key={commit.oid}>
        {header && <div className="day">Commits on {header}</div>}
        <a className="commit-row" href={href(place, "commit", { oid: commit.oid })} onClick={onLink}>
          <Avatar name={commit.author} size={28} />
          <span className="row-main"><strong>{commit.subject || "(no message)"}</strong><span>{commit.author} · <Ago iso={commit.time} /></span></span>
          <span className="mono quiet">{commit.oid.slice(0, 7)}</span>
        </a>
      </li>;
    })}</ol> : <Empty icon={<GitCommitHorizontal size={20} />} title="No commits" />)}
    {live.data && (num > 1 || live.data.more) && <div className="pager">
      {num > 1 ? <a className="button ghost" href={href(place, "commits", { ref: current, path, page: num - 1 })} onClick={onLink}><ChevronLeft size={15} />Newer</a> : <span />}
      {live.data.more && <a className="button ghost" href={href(place, "commits", { ref: current, path, page: num + 1 })} onClick={onLink}>Older<ChevronRight size={15} /></a>}
    </div>}
  </div>;
}

export function CommitTab({ place, oid }: { place: Place; oid: string }) {
  const live = useLive<CommitDetail>(codeUrl(place, "commit", { oid }), 0);
  const commit = live.data;
  if (live.error) return <ErrorNote message={live.error} retry={live.refresh} />;
  if (!commit) return <div className="code-tab"><div className="panel"><div className="panel-head"><Skeleton width="50%" height={16} /></div><SkeletonText lines={14} /></div></div>;
  const adds = commit.files.reduce((sum, file) => sum + file.adds, 0);
  const dels = commit.files.reduce((sum, file) => sum + file.dels, 0);
  return <div className="code-tab">
    <div className="panel">
      <div className="commit-head">
        <h2>{commit.subject || "(no message)"}</h2>
        {commit.body && <pre className="commit-body">{commit.body}</pre>}
        <div className="commit-by"><Avatar name={commit.author.name} size={24} /><strong>{commit.author.name}</strong><span className="quiet">committed <Ago iso={commit.committer.time} /></span>
          <span className="toolbar-spacer" />
          {commit.parents.map(parent => <a key={parent} className="mono quiet" href={href(place, "commit", { oid: parent })} onClick={onLink}>parent {parent.slice(0, 7)}</a>)}
          <span className="mono">{commit.oid.slice(0, 7)}</span><CopyButton text={commit.oid} label="Copy commit id" />
          <a className="button ghost small" href={href(place, "code", { ref: commit.oid })} onClick={onLink}><Code2 size={14} />Browse files</a></div>
      </div>
      <div className="panel-subhead"><span>{commit.files.length} {commit.files.length === 1 ? "file" : "files"} changed</span><span className="adds">+{adds}</span><span className="dels">-{dels}</span></div>
    </div>
    {commit.files.map(file => <div className="panel diff" key={file.path}>
      <div className="panel-head"><span className={`status status-${file.status}`}>{file.status}</span>
        {file.status === "D" ? <span className="mono">{file.path}</span> : <a className="mono" href={href(place, "code", { ref: commit.oid, path: file.path })} onClick={onLink}>{file.path}</a>}
        <span className="toolbar-spacer" /><span className="adds">+{file.adds}</span><span className="dels">-{file.dels}</span></div>
      {file.note ? <p className="quiet padded">{file.note}</p> : <div className="code-box"><table className="code diff-table"><tbody>{(file.hunks ?? []).map((hunk, h) => [
        <tr key={`h${h}`} className="hunk"><td className="line-no" /><td className="line-no" /><td className="line">{hunk.header}</td></tr>,
        ...hunk.lines.map(([kind, before, after, text], i) => <tr key={`${h}-${i}`} className={kind === "+" ? "add" : kind === "-" ? "del" : undefined}>
          <td className="line-no">{before ?? ""}</td><td className="line-no">{after ?? ""}</td><td className="line">{kind}{text}</td>
        </tr>),
      ])}</tbody></table></div>}
    </div>)}
    {commit.truncated && <p className="quiet">Showing the first 300 changed files.</p>}
  </div>;
}

export function BranchesTab({ place }: { place: Place }) {
  const live = useLive<Refs>(codeUrl(place, "refs"), 5000);
  if (live.error) return <ErrorNote message={live.error} retry={live.refresh} />;
  if (!live.data) return <SkeletonRows rows={5} />;
  const group = (title: string, rows: Refs["branches"], icon: React.ReactNode) => rows.length > 0 && <section>
    <h2 className="section-title">{title} <span className="quiet">{rows.length}</span></h2>
    <ul className="rows">{rows.map(ref => <li key={ref.kind + ref.name}><a className="row" href={href(place, "code", { ref: ref.name })} onClick={onLink}>
      <span className="row-icon">{icon}</span>
      <span className="row-main"><strong>{ref.name}{ref.name === live.data!.defaultBranch && <span className="badge">default</span>}{ref.diverged && <span className="badge warn">diverged from GitHub</span>}</strong>
        {ref.commit && <span>{ref.commit.subject} · {ref.commit.author}</span>}</span>
      <span className="row-meta">{ref.commit && <Ago iso={ref.commit.time} />}</span>
    </a></li>)}</ul>
  </section>;
  return <div className="code-tab">{group("Branches", live.data.branches, <GitBranch size={17} />)}{group("Tags", live.data.tags, <Tag size={17} />)}
    {!live.data.branches.length && !live.data.tags.length && <Empty icon={<GitBranch size={20} />} title="No branches yet" />}</div>;
}
