// Look and page shell shared by the module's web UI and the web service
// (sign in, sign up, import), so both halves of the site match.

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const CSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--subtle:#f6f8fa;--link:#0969da;--head:#1f2328;--headfg:#fff;--dir:#54aeff;--A:#1a7f37;--D:#cf222e;--M:#9a6700;--addbg:#dafbe1;--delbg:#ffebe9;--hunkbg:#ddf4ff;--hl:#fff8c5;--btn:#1f883d}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--subtle:#151b23;--link:#4493f8;--head:#010409;--headfg:#e6edf3;--dir:#7d8590;--A:#3fb950;--D:#f85149;--M:#d29922;--addbg:rgba(46,160,67,.15);--delbg:rgba(248,81,73,.15);--hunkbg:rgba(56,139,253,.12);--hl:rgba(187,128,9,.2);--btn:#238636}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--head);color:var(--headfg);padding:12px 16px;display:flex;align-items:center;gap:16px}
header .home{color:var(--headfg);font-weight:600;font-size:16px;flex:1}
header nav{display:flex;align-items:center;gap:16px}header nav a,header nav button{color:var(--headfg);font:inherit;background:none;border:0;padding:0;cursor:pointer}
header nav form{margin:0}header nav .me{color:var(--headfg);opacity:.75}
main{max-width:1080px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;font-weight:400;margin:0 0 4px;word-break:break-word}h1 b{font-weight:600}
h2{font-size:14px;font-weight:600;margin:0 0 8px}
.desc{color:var(--muted);margin:0 0 12px}
nav.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:12px 0 20px;overflow-x:auto}
nav.tabs a{color:var(--fg);padding:8px 12px;border-bottom:2px solid transparent;white-space:nowrap}
nav.tabs a.on{border-color:#fd8c73;font-weight:600}nav.tabs a:hover{text-decoration:none;background:var(--subtle)}
.box{border:1px solid var(--line);border-radius:6px;margin-bottom:16px;background:var(--bg)}
.box>:first-child{border-top-left-radius:6px;border-top-right-radius:6px}
.bar{background:var(--subtle);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:8px 16px;flex-wrap:wrap;align-items:center}
.bar .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
td{padding:8px 16px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}
td.r{text-align:right;white-space:nowrap}td.msg{color:var(--muted);max-width:0;width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td.msg a{color:var(--muted)}@media (max-width:700px){td.msg{display:none}}
.muted{color:var(--muted)}.nowrap{white-space:nowrap}.day{background:var(--subtle);font-size:12px;color:var(--muted);font-weight:600}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:12px}
pre{margin:0;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.code table td,.diff table td{border:0;padding:0 12px;white-space:pre;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:20px}
.code td.n,.diff td.n{color:var(--muted);text-align:right;user-select:none;width:1%;padding:0 8px}.code td.n a{color:var(--muted)}
.code tr:target td{background:var(--hl)}
.diff tr.add td{background:var(--addbg)}.diff tr.del td{background:var(--delbg)}.diff tr.hunk td{background:var(--hunkbg);color:var(--muted)}
.pill{display:inline-block;border:1px solid var(--line);border-radius:2em;padding:0 8px;font-size:12px;color:var(--muted)}
.clone{display:block;padding:6px 8px;background:var(--subtle);border:1px solid var(--line);border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;user-select:all;overflow-x:auto;white-space:nowrap;margin:4px 0 12px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:24px}@media (max-width:820px){.grid{grid-template-columns:minmax(0,1fr)}}
aside p{margin:0 0 12px}aside dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 16px}aside dt{color:var(--muted)}aside dd{margin:0;word-break:break-word}
.i{width:16px;height:16px;fill:var(--dir);vertical-align:text-bottom;margin-right:8px}.i.f{fill:var(--muted)}
.st{font-weight:600;font-family:ui-monospace,Menlo,monospace;margin-right:8px}.A{color:var(--A)}.D{color:var(--D)}.M{color:var(--M)}
.empty{padding:32px 16px;text-align:center;color:var(--muted)}
.btn{display:inline-block;padding:5px 16px;border:1px solid var(--line);border-radius:6px;background:var(--subtle);color:var(--fg);font:inherit;font-weight:500;cursor:pointer;line-height:20px}
.btn:hover{text-decoration:none;filter:brightness(.97)}.btn.primary{background:var(--btn);border-color:var(--btn);color:#fff}
form.inline{display:inline;margin:0}
label{display:block;font-weight:600;margin:16px 0 4px}label .muted{font-weight:400}
select,input[type=text],input[type=url],input[type=password],textarea{width:100%;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
textarea{font-family:ui-monospace,Menlo,monospace;font-size:12px;min-height:90px}
.narrow{max-width:560px}
.banner{border:1px solid var(--line);border-radius:6px;padding:12px 16px;margin:0 0 16px;background:var(--subtle)}
.banner.err{border-color:var(--D)}.banner.ok{border-color:var(--A)}.banner form{margin-top:8px}
details.menu{position:relative;display:inline-block}details.menu>summary{list-style:none;cursor:pointer}details.menu>summary::-webkit-details-marker{display:none}
details.menu .pop{position:absolute;z-index:10;top:calc(100% + 4px);left:0;min-width:240px;max-width:340px;max-height:360px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.2);padding:6px 0}
.pop .h{padding:4px 12px;font-size:12px;color:var(--muted);font-weight:600}.pop a{display:block;padding:4px 12px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pop a.on{font-weight:600}.pop a:hover{background:var(--subtle);text-decoration:none}
.md{padding:8px 32px 24px;word-wrap:break-word;line-height:1.6;font-size:15px}
.md h1,.md h2{border-bottom:1px solid var(--line);padding-bottom:.3em;margin:24px 0 16px;font-weight:600}.md h1{font-size:2em}.md h2{font-size:1.5em}.md h3{font-size:1.25em}
.md pre{background:var(--subtle);border-radius:6px}.md code{background:var(--subtle);padding:.15em .35em;border-radius:4px}.md pre code{background:none;padding:0}
.md table{width:auto;margin:12px 0;display:block;overflow-x:auto}.md td,.md th{border:1px solid var(--line);padding:6px 13px}.md th{background:var(--subtle)}
.md blockquote{margin:0 0 16px;padding:0 1em;color:var(--muted);border-left:.25em solid var(--line)}.md img{max-width:100%}
.img{padding:24px;text-align:center;background:var(--subtle)}.img img{max-width:100%}
.guide-box{padding:16px 20px;margin-bottom:24px}.guide-lead{margin:0;font-size:15px;flex:1;min-width:240px}
.guide-head{display:flex;gap:12px 24px;align-items:flex-start;flex-wrap:wrap;margin:0 0 12px}
.guide-page{max-width:820px}.guide-page section{margin:28px 0 0;padding-top:20px;border-top:1px solid var(--line)}
.guide-page h2{font-size:18px;margin:0 0 10px}.guide-page h3{font-size:14px;margin:16px 0 6px}.guide-page p,.guide-page li{line-height:1.6}
.guide-page ol,.guide-page ul{padding-left:20px}.guide-page li{margin:0 0 8px}.guide-page .clone{white-space:pre-wrap;overflow-wrap:anywhere}
.toc{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 0}.toc a{border:1px solid var(--line);border-radius:2em;padding:2px 12px;font-size:13px}
.terms{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:12px 0 0}.terms dt{font-weight:600}.terms dd{margin:0}
.cases{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.case{border:1px solid var(--line);border-radius:6px;padding:12px 16px}.case h3{margin:0 0 6px}.case p{margin:0 0 8px}
.guide{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.7fr) minmax(0,1fr);gap:12px 28px}@media (max-width:900px){.guide{grid-template-columns:minmax(0,1fr)}}
.guide h3{font-size:13px;font-weight:600;margin:0 0 6px}.guide ul,.guide ol{margin:0;padding-left:18px}.guide li{margin:0 0 6px}.guide p{margin:6px 0 0}.guide .clone{margin:4px 0 6px;white-space:pre-wrap;overflow-wrap:anywhere}
header .live{font-size:12px;opacity:.85}header .live::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--A);margin-right:6px}header .live.off::before{background:var(--muted)}
`;

// The page frame: header (home link + `nav` HTML) and the main column.
export function shell(title: string, nav: string, body: string, head = '', home = '/'): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>${esc(title)}</title><style>${CSS}</style></head><body><header><a class="home" href="${esc(home)}">spacehub</a><nav>${nav}</nav></header><main>${body}</main></body></html>`;
}

// Header links for a viewer: a signed-in agent (its name) or anonymous (null).
export function navFor(viewer: string | null): string {
  if (!viewer) return `<a href="/-/guide">Guide</a><a href="/-/login">Sign in</a><a href="/-/signup">Register</a>`;
  return `<a href="/-/guide">Guide</a><a href="/-/new">+ New project</a><a class="me" href="/${encodeURIComponent(viewer)}">${esc(viewer)}</a><form method="post" action="/-/logout"><button type="submit">Sign out</button></form>`;
}

// Scripts and connections only to this site: /-/live.js and its stream.
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
