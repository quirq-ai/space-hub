// A small, safe Markdown renderer for READMEs and .md files. Everything is
// escaped first; raw HTML in the source is shown as text, and links only
// keep http(s), mailto, #anchors or paths inside the repository.
import { esc } from './style';

// Turns a link target into an href: `image` is true for ![..](..).
// Returns null for targets that must not become links (javascript: etc).
export type Resolve = (url: string, image: boolean) => { href: string; inline: boolean } | null;

// An image link to a video plays in place.
const VIDEO = /\.(mp4|m4v|webm|mov|ogv)(?:[?#]|$)/i;
const LIST_ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+/;
// Inside a paragraph only bullets and lists numbered from 1 start a new list.
const INTERRUPTS_PARAGRAPH = /^\s*([-*+]|1[.)])\s+/;

function inline(src: string, resolve: Resolve): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  const emphasis = (s: string) =>
    s
      .replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)(.+?)__/g, '<strong>$1</strong>')
      .replace(/~~(?=\S)(.+?)~~/g, '<del>$1</del>')
      .replace(/(^|[^\w*])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|\W)_(?=\S)([^_]+?)_(?!\w)/g, '$1<em>$2</em>');

  let s = src.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, alt, url) => {
    const target = resolve(url, true);
    if (!target) return hold(esc(alt));
    return hold(
      target.inline && VIDEO.test(target.href)
        ? `<video src="${esc(target.href)}" controls preload="metadata" playsinline aria-label="${esc(alt)}"></video>`
        : target.inline
        ? `<img src="${esc(target.href)}" alt="${esc(alt)}">`
        : `<a href="${esc(target.href)}">${esc(alt || 'image')}</a>`
    );
  });
  s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, text, url) => {
    const target = resolve(url, false);
    const label = emphasis(esc(text));
    return hold(target ? `<a href="${esc(target.href)}">${label}</a>` : label);
  });
  s = esc(s);
  s = s.replace(/\bhttps?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s<\u0000])+/g, match => {
    const url = match.replace(/[.,;:!?)]+$/, '');
    return `<a href="${url}">${url}</a>${match.slice(url.length)}`;
  });
  s = emphasis(s);
  for (let guard = 0; guard < 8 && s.includes('\u0000'); guard++) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => held[Number(n)] ?? '');
  }
  return s;
}

export function renderMarkdown(source: string, resolve: Resolve, depth = 0): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      out.push(`<h${atx[1].length}>${inline(atx[2], resolve)}</h${atx[1].length}>`);
      i++;
      continue;
    }
    if (i + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1]) && !LIST_ITEM.test(line)) {
      const level = lines[i + 1].trim().startsWith('=') ? 1 : 2;
      out.push(`<h${level}>${inline(line.trim(), resolve)}</h${level}>`);
      i += 2;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(depth < 4 ? `<blockquote>${renderMarkdown(body.join('\n'), resolve, depth + 1)}</blockquote>` : `<p>${esc(body.join(' '))}</p>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i])) {
        let item = lines[i++].replace(LIST_ITEM, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_ITEM.test(lines[i])) item += ` ${lines[i++].trim()}`;
        const task = /^\[([ xX])\]\s+/.exec(item);
        const box = task ? (task[1] === ' ' ? '☐ ' : '☑ ') : '';
        items.push(`<li>${box}${inline(task ? item.slice(task[0].length) : item, resolve)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map(c => `<th>${inline(c, resolve)}</th>`).join('')}</tr></thead><tbody>${rows
          .map(r => `<tr>${r.map(c => `<td>${inline(c, resolve)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      );
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(`{3,}|~{3,}|#{1,6}\s|>)/.test(lines[i]) && !INTERRUPTS_PARAGRAPH.test(lines[i])) {
      if (i + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1])) break;
      para.push(lines[i++].trim());
    }
    out.push(`<p>${inline(para.join(' '), resolve)}</p>`);
  }
  return out.join('\n');
}
