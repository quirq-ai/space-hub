
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, Code2, FileText, LockKeyhole } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FileView } from "@/lib/types";
import { parseJsonl, jsonlPost } from "@/lib/jsonl";
import { parseUrlFile } from "@/lib/url-file";
import { isConversation } from "@/lib/conversation";

type ObjectValue = Record<string, unknown>;
type Navigate = (path: string) => void;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown) => typeof value === "string" ? value : "";

function localLink(href: string, filePath: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//") || href.includes("\\")) return;
  let decoded: string;
  try { decoded = decodeURIComponent(href.split("#")[0]); } catch { return; }
  const parts = href.startsWith("/") ? [] : filePath.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return; parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/");
}

export function Markdown({ content, filePath, navigate }: { content: string; filePath: string; navigate: Navigate }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href = "", children }) => {
      if (/^(https?:\/\/|mailto:)/i.test(href)) return <a href={href} target="_blank" rel="noreferrer noopener">{children}<ArrowUpRight size={12} /></a>;
      if (href.startsWith("#")) return <a href={href}>{children}</a>;
      const path = localLink(href, filePath);
      return path === undefined ? <span>{children}</span> : <button className="inline-link" onClick={() => navigate(path)}>{children}</button>;
    },
    img: ({ alt }) => <span className="muted">[Image: {alt || "Open the image file to preview"}]</span>,
    input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled aria-label={checked ? "Completed item" : "Incomplete item"} />
  }}>{content}</ReactMarkdown></div>;
}

function JsonNode({ value, name, depth = 0 }: { value: unknown; name?: string; depth?: number }) {
  const isContainer = object(value) || Array.isArray(value);
  if (!isContainer) return <div className="json-leaf">{name !== undefined && <span className="json-key">{name}</span>}<span className={`json-value ${typeof value}`}>{typeof value === "string" ? value : JSON.stringify(value)}</span></div>;
  const pairs = Object.entries(value as object);
  return <details className="json-node" open={depth < 2}>
    <summary><ChevronRight size={13} /><span>{name ?? (Array.isArray(value) ? "Array" : "Object")}</span><small>{pairs.length} {Array.isArray(value) ? "items" : "fields"}</small></summary>
    {depth < 8 ? <div className="json-children">{pairs.slice(0, 100).map(([key, child]) => <JsonNode key={key} name={key} value={child} depth={depth + 1} />)}{pairs.length > 100 && <p className="muted">{pairs.length - 100} more entries are available in Source.</p>}</div> : <p className="muted">Open Source to inspect deeper values.</p>}
  </details>;
}

function JsonlFeed({ content, filePath, navigate }: { content: string; filePath: string; navigate: Navigate }) {
  const records = useMemo(() => parseJsonl(content), [content]);
  const [page, setPage] = useState(0);
  const pageSize = 25;
  const pages = Math.max(1, Math.ceil(records.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const invalid = records.filter(record => record.error).length;
  return <section className="jsonl-feed" aria-label="JSONL feed">
    <div className="feed-heading"><div><h1>File feed</h1><p>{records.length} {records.length === 1 ? "post" : "posts"} · In file order{invalid ? " · " + invalid + " invalid " + (invalid === 1 ? "line" : "lines") : ""}</p></div><span className="chip">JSONL</span></div>
    {!records.length && <div className="empty-state"><FileText /><h2>No posts yet</h2><p>Add one JSON record per line to this file. Posts appear automatically.</p></div>}
    <div className="feed-posts">{records.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(record => {
      if (record.error) return <article className="feed-post feed-post-error" key={record.line}><header><strong>Incomplete post</strong><span className="chip">Line {record.line}</span></header><p className="muted">{record.error} Other posts remain available.</p><details className="feed-record"><summary>View original line</summary><pre className="source-code"><code>{record.raw}</code></pre></details></article>;
      const post = jsonlPost(record.value);
      return <article className="feed-post" key={record.line}>
        <header><span className="feed-avatar" aria-hidden="true">{post.author.slice(0, 1).toUpperCase()}</span><div className="feed-byline"><strong>{post.author}</strong>{post.time && <span>{post.time}</span>}</div><span className="feed-line">Line {record.line}</span></header>
        {post.kind && <span className="chip feed-kind">{post.kind}</span>}
        {post.title && <h2>{post.title}</h2>}
        {post.body ? <div className="feed-body"><Markdown content={post.body} filePath={filePath} navigate={navigate} /></div> : <div className="feed-data"><JsonNode value={record.value} /></div>}
        {post.body && <details className="feed-record"><summary>View JSON record</summary><JsonNode value={record.value} /></details>}
      </article>;
    })}</div>
    {pages > 1 && <nav className="feed-pagination" aria-label="Feed pages"><button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><span role="status">Page {currentPage + 1} of {pages}</span><button disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}
  </section>;
}

export { isConversation };

function Conversation({ data, filePath, navigate, demo, endNote }: { data: ObjectValue & { messages: ObjectValue[] }; filePath: string; navigate: Navigate; demo?: boolean; endNote?: string }) {
  return <div className="conversation">
    <div className="conversation-intro"><span className="eyebrow">A LITTLE ROOM FOR YOUR FILES</span><h1>{string(data.title) || "Conversation"}</h1>{string(data.subtitle) && <p>{string(data.subtitle)}</p>}</div>
    <div className="messages">{data.messages.map((message, index) => <article key={index} className={`message ${string(message.role)}`}>
      {message.role !== "user" && <span className="message-author">{message.role === "system" ? "Note" : "quirqy"}{string(message.time) && <span> · {string(message.time)}</span>}</span>}
      <div className="bubble"><Markdown content={string(message.content)} filePath={filePath} navigate={navigate} />
        {Array.isArray(message.links) && <div className="message-links">{message.links.filter(object).map((link, i) => typeof link.path === "string" && <button key={i} onClick={() => navigate(string(link.path))}><FileText size={15} /><span>{string(link.label) || string(link.path)}</span><ArrowUpRight size={14} /></button>)}</div>}
      </div>
      {message.role === "user" && string(message.time) && <span className="message-time">{string(message.time)}</span>}
    </article>)}</div>
    <div className="conversation-end"><LockKeyhole size={12} />{endNote ?? (demo ? "Sample conversation · files stay unchanged" : "Saved conversation · read from this file")}</div>
  </div>;
}

function Collection({ data, navigate }: { data: ObjectValue & { items: ObjectValue[] }; navigate: Navigate }) {
  return <section><div className="section-heading"><h1>{string(data.title) || "Collection"}</h1>{string(data.subtitle) && <p>{string(data.subtitle)}</p>}</div><div className="collection">
    {data.items.map((item, i) => {
      const status = string(item.status);
      const completed = /^(complete|completed|done)$/i.test(status);
      const content = <>
        <div className="between"><span className="eyebrow">{string(item.category) || "SAVED ITEM"}</span>{status && <span className={`chip ${completed ? "green" : ""}`}>{completed && <Check size={11} />}{status}</span>}</div>
        <h2>{string(item.title)}</h2>{string(item.description) && <p>{string(item.description)}</p>}
        {typeof item.progress === "number" && Number.isFinite(item.progress) && <div className="progress-row"><progress value={Math.max(0, Math.min(100, item.progress))} max="100" aria-label={`${string(item.title)} progress`} /><span>{Math.round(Math.max(0, Math.min(100, item.progress)))}%</span></div>}
        {(string(item.meta) || string(item.path)) && <div className="card-footer"><span>{string(item.meta) || string(item.path)}</span>{string(item.path) && <ArrowUpRight size={16} />}</div>}
      </>;
      return string(item.path) ? <button className="collection-card" key={i} onClick={() => navigate(string(item.path))}>{content}</button> : <article className="collection-card" key={i}>{content}</article>;
    })}
    {!data.items.length && <div className="empty-state"><FileText /><h2>No saved items yet</h2><p>Add an item to this JSON file and it will appear here.</p></div>}
  </div></section>;
}

function ImagePreview({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed ? <div className="empty-state"><FileText /><h2>Preview unavailable</h2><p>The file may have changed or may not contain a supported image.</p></div> : <figure className="image-preview"><img src={src} alt={name} onError={() => setFailed(true)} /><figcaption>{name}</figcaption></figure>;
}

function UrlPreview({ content, name }: { content: string; name: string }) {
  const url = parseUrlFile(content);
  if (!url) return <div className="empty-state"><FileText /><h2>No valid web URL</h2><p>Save a single http:// or https:// address, or a Windows Internet Shortcut with a URL entry. Use Source to inspect this file.</p></div>;
  return <section className="url-preview" aria-label="Webpage preview">
    <div className="url-preview-bar"><span title={url}>{url}</span><a href={url} target="_blank" rel="noopener noreferrer">Open in new tab <ArrowUpRight size={15} /></a></div>
    <iframe key={url} title={"Webpage: " + name} src={url} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />
    <p className="url-preview-note">Some websites block embedded previews. Use Open in new tab if the page does not load.</p>
  </section>;
}

export function FileContent({ file, revision, navigate, demo = false, extraMessages = [], endNote, src: fileSrc }: { file: FileView; revision: string; navigate: Navigate; demo?: boolean; extraMessages?: ObjectValue[]; endNote?: string; src?: string }) {
  const [source, setSource] = useState(false);
  const canReadSource = typeof file.content === "string";
  const src = `${fileSrc ?? `/api/file?path=${encodeURIComponent(file.path)}`}${fileSrc?.includes("?") ? "&" : "?"}v=${encodeURIComponent(revision)}`;
  let content: React.ReactNode;
  if (file.error && !canReadSource) content = <div className="empty-state"><FileText /><h2>File on disk</h2><p>{file.error}</p><code>{file.path}</code></div>;
  else if (source && canReadSource) content = <pre className="source-code"><code>{file.content}</code></pre>;
  else if (file.format === "url") content = <UrlPreview content={file.content || ""} name={file.name} />;
  else if (file.format === "jsonl") content = <JsonlFeed key={file.path} content={file.content || ""} filePath={file.path} navigate={navigate} />;
  else if (file.format === "json" && isConversation(file.data)) content = <Conversation data={{ ...file.data, messages: [...file.data.messages, ...extraMessages] }} filePath={file.path} navigate={navigate} demo={demo} endNote={endNote} />;
  else if (file.format === "json" && object(file.data) && file.data.type === "collection" && Array.isArray(file.data.items) && file.data.items.every(item => object(item) && typeof item.title === "string")) content = <Collection data={file.data as ObjectValue & { items: ObjectValue[] }} navigate={navigate} />;
  else if (file.format === "json" && !file.error) content = <div className="document-card"><JsonNode value={file.data} /></div>;
  else if (file.format === "markdown") content = <article className="document-card"><Markdown content={file.content || ""} filePath={file.path} navigate={navigate} /></article>;
  else if (file.format === "image") content = <ImagePreview src={src} name={file.name} />;
  else if (file.format === "pdf") content = <div className="pdf-preview"><iframe title={`PDF: ${file.name}`} src={src} /><a href={src} target="_blank" rel="noreferrer">Open PDF in a new tab <ArrowUpRight size={14} /></a></div>;
  else if (canReadSource) content = <pre className="source-code"><code>{file.content || "This file is empty."}</code></pre>;
  else content = <div className="empty-state"><FileText /><h2>File on disk</h2><p>{file.error || "A preview is not available for this file type."}</p><code>{file.path}</code></div>;
  return <>
    <div className="file-toolbar"><span title={file.path}><FileText size={13} />{file.name}</span>{canReadSource && <button className={source ? "active" : ""} aria-pressed={source} onClick={() => setSource(value => !value)}><Code2 size={14} />{source ? "Preview" : "Source"}</button>}</div>
    {file.error && canReadSource && <p className="notice warning" role="status">{file.error}</p>}
    {content}
  </>;
}
