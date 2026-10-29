// Look and page shell shared by the module's web UI and the web service
// (sign in, sign up, import), so both halves of the site match.

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// The app's design (app/src/app.css): one neutral palette, one accent, light
// and dark. data-theme comes from /-/app/theme.js (the reader's choice, shared
// with the app); without it the system's preference applies.
export const CSS = `
:root{--font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Inter,system-ui,sans-serif;--bg:#f6f6f4;--panel:#fff;--side:#f1f1ee;--fill:#ececea;--hover:rgba(20,20,18,.045);--selected:rgba(20,20,18,.075);--line:rgba(20,20,18,.09);--line-strong:rgba(20,20,18,.16);--fg:#1c1c1a;--muted:#5d5d58;--faint:#8b8b85;--link:#2552b8;--accent:#2d63d8;--accent-soft:rgba(45,99,216,.1);--on-accent:#fff;--A:#2a8a52;--D:#c4392f;--M:#9a6700;--addbg:rgba(42,138,82,.12);--delbg:rgba(196,57,47,.1);--hunkbg:rgba(45,99,216,.1);--hl:rgba(196,140,30,.18);--shadow:0 1px 2px rgba(0,0,0,.05),0 6px 24px rgba(0,0,0,.07);--shadow-lg:0 2px 6px rgba(0,0,0,.06),0 18px 48px rgba(0,0,0,.14);--subtle:var(--fill);color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161616;--panel:#1d1d1c;--side:#191918;--fill:#2a2a28;--hover:rgba(255,255,255,.05);--selected:rgba(255,255,255,.09);--line:rgba(255,255,255,.09);--line-strong:rgba(255,255,255,.17);--fg:#ececea;--muted:#a8a8a2;--faint:#7b7b76;--link:#8fb3f6;--accent:#6b9bf2;--accent-soft:rgba(107,155,242,.15);--on-accent:#0d1424;--A:#5cc58a;--D:#f07167;--M:#e1b45a;--addbg:rgba(92,197,138,.14);--delbg:rgba(240,113,103,.13);--hunkbg:rgba(107,155,242,.15);--hl:rgba(225,180,90,.18);--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 28px rgba(0,0,0,.35);--shadow-lg:0 2px 8px rgba(0,0,0,.4),0 20px 56px rgba(0,0,0,.5);color-scheme:dark}}
:root[data-theme=dark]{--bg:#161616;--panel:#1d1d1c;--side:#191918;--fill:#2a2a28;--hover:rgba(255,255,255,.05);--selected:rgba(255,255,255,.09);--line:rgba(255,255,255,.09);--line-strong:rgba(255,255,255,.17);--fg:#ececea;--muted:#a8a8a2;--faint:#7b7b76;--link:#8fb3f6;--accent:#6b9bf2;--accent-soft:rgba(107,155,242,.15);--on-accent:#0d1424;--A:#5cc58a;--D:#f07167;--M:#e1b45a;--addbg:rgba(92,197,138,.14);--delbg:rgba(240,113,103,.13);--hunkbg:rgba(107,155,242,.15);--hl:rgba(225,180,90,.18);--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 28px rgba(0,0,0,.35);--shadow-lg:0 2px 8px rgba(0,0,0,.4),0 20px 56px rgba(0,0,0,.5);color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased;display:grid;grid-template:"top top" 52px "side main" minmax(0,1fr)/236px minmax(0,1fr);height:100vh;overflow:hidden}
body.no-side{grid-template:"top" 52px "main" minmax(0,1fr)/minmax(0,1fr)}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
svg.ic{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none;vertical-align:-3px}
header{grid-area:top;display:flex;align-items:center;gap:10px;padding:0 14px;background:var(--panel);border-bottom:1px solid var(--line);min-width:0}
header .home{display:flex;align-items:center;gap:8px;color:var(--fg);font-weight:650;letter-spacing:-.2px;padding:4px 6px;border-radius:6px}
header .home svg.mark{width:22px;height:22px;flex:none}header .home svg.mark rect{fill:var(--fg)}header .home svg.mark path{fill:var(--panel)}header .home:hover{text-decoration:none;background:var(--hover)}
header .search{display:flex;align-items:center;gap:8px;width:min(420px,40vw);height:32px;margin-left:18px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--faint)}
header .search:hover{text-decoration:none;border-color:var(--line-strong)}header .search span{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
kbd{padding:1px 6px;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;color:var(--faint);font:11px ui-monospace,Menlo,monospace;background:var(--panel)}
header .spacer{flex:1}
header nav{display:flex;align-items:center;gap:10px}header nav form{margin:0}
header .live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
header .live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--A);box-shadow:0 0 0 3px var(--addbg)}header .live.off::before{background:var(--faint);box-shadow:none}
details.acct{position:relative}details.acct>summary{list-style:none;display:flex;align-items:center;gap:2px;padding:2px 4px 2px 2px;border-radius:20px;cursor:pointer;color:var(--faint)}
details.acct>summary::-webkit-details-marker{display:none}details.acct>summary:hover,details.acct[open]>summary{background:var(--hover)}
.av{border-radius:50%;background:var(--fill);vertical-align:middle;flex:none;object-fit:cover}
details.acct .pop{position:absolute;right:0;top:calc(100% + 6px);z-index:20;min-width:220px;padding:6px;border:1px solid var(--line);border-radius:12px;background:var(--panel);box-shadow:var(--shadow-lg)}
.acct-head{display:flex;align-items:center;gap:10px;padding:8px 8px 10px;margin-bottom:4px;border-bottom:1px solid var(--line)}.acct-head span{display:block;color:var(--faint);font-size:12px}
details.acct .pop a,details.acct .pop button{display:flex;align-items:center;gap:9px;width:100%;padding:7px 8px;border:0;border-radius:6px;background:none;color:var(--fg);font:13px var(--font);text-align:left;cursor:pointer}
details.acct .pop a:hover,details.acct .pop button:hover{text-decoration:none;background:var(--hover)}
aside.side{grid-area:side;display:flex;flex-direction:column;min-height:0;padding:10px 8px 8px;background:var(--side);border-right:1px solid var(--line)}
.side-title{padding:6px 10px 4px;color:var(--faint);font-size:11.5px;font-weight:600}
.side a{display:flex;align-items:center;gap:9px;height:30px;padding:0 10px;border-radius:7px;color:var(--muted);font-size:13px}
.side a:hover{text-decoration:none;background:var(--hover);color:var(--fg)}.side a.on{background:var(--selected);color:var(--fg);font-weight:550}
.side .group{display:grid;gap:1px}.side .grow{flex:1}.side .foot{display:grid;gap:1px;padding-top:6px;border-top:1px solid var(--line)}
.side .hub{display:flex;align-items:center;gap:9px;padding:6px 8px;margin-bottom:8px;border-radius:9px;color:var(--fg);line-height:1.25}.side .hub:hover{background:var(--panel);text-decoration:none}
.side .hub b{display:block;font-size:13px}.side .hub span{display:block;color:var(--faint);font-size:11.5px}.side .hub i{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:var(--fill);color:var(--muted)}
.side .group{padding-bottom:8px;border-bottom:1px solid var(--line)}.side kbd{margin-left:auto;font-size:10.5px;padding:0 5px}
main{grid-area:main;overflow-y:auto;padding:22px max(36px,calc((100% - 1060px) / 2)) 48px;min-width:0}
h1{font-size:22px;font-weight:650;letter-spacing:-.4px;line-height:1.25;margin:0 0 4px;word-break:break-word}h1 b{font-weight:650}
h2{font-size:15px;font-weight:600;margin:0 0 8px}
.desc{color:var(--muted);margin:0 0 14px}
nav.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:14px 0 18px;overflow-x:auto;scrollbar-width:none}
nav.tabs a{color:var(--muted);padding:8px 12px;margin-bottom:-1px;border-bottom:2px solid transparent;white-space:nowrap;font-weight:500;font-size:13.5px}
nav.tabs a.on{color:var(--fg);border-color:var(--fg)}nav.tabs a:hover{text-decoration:none;color:var(--fg)}
.box{border:1px solid var(--line);border-radius:12px;margin-bottom:16px;background:var(--panel);overflow:hidden}
.bar{background:var(--bg);border-bottom:1px solid var(--line);padding:9px 14px;display:flex;gap:8px 16px;flex-wrap:wrap;align-items:center;min-height:44px;font-size:13px}
.bar .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
td{padding:9px 14px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}
.box table tr:hover td{background:var(--hover)}
td.r{text-align:right;white-space:nowrap;color:var(--faint);font-size:12px}td.msg{color:var(--muted);max-width:0;width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td.msg a{color:var(--muted)}@media (max-width:700px){td.msg{display:none}}
.muted{color:var(--muted)}.nowrap{white-space:nowrap}.day{background:var(--bg);font-size:12px;color:var(--muted);font-weight:600}
code,pre,.mono{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
pre{margin:0;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.code table td,.diff table td{border:0;padding:0 12px;white-space:pre;font:12.5px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.code table tr:hover td,.diff table tr:hover td{background:none}
.code td.n,.diff td.n{color:var(--faint);text-align:right;user-select:none;width:1%;padding:0 10px}.code td.n a{color:var(--faint)}
.code tr:target td{background:var(--hl)}
.diff tr.add td{background:var(--addbg)}.diff tr.del td{background:var(--delbg)}.diff tr.hunk td{background:var(--hunkbg);color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:20px;background:var(--fill);color:var(--muted);font-size:12px;font-weight:500}
.clone{display:block;padding:7px 10px;background:var(--bg);border:1px solid var(--line);border-radius:8px;font:11.5px ui-monospace,Menlo,monospace;user-select:all;overflow-x:auto;white-space:nowrap;margin:4px 0 12px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:28px}@media (max-width:980px){.grid{grid-template-columns:minmax(0,1fr)}}
aside p{margin:0 0 12px}aside dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0 0 16px;font-size:13px}aside dt{color:var(--muted)}aside dd{margin:0;word-break:break-word}
.grid>aside h2{font-size:12px;color:var(--muted);margin-top:4px}
.i{width:16px;height:16px;fill:var(--accent);vertical-align:text-bottom;margin-right:8px}.i.f{fill:var(--faint)}
.st{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;font:600 11px ui-monospace,Menlo,monospace;margin-right:8px}
.A{color:var(--A)}.D{color:var(--D)}.M{color:var(--M)}.st.A{background:var(--addbg)}.st.D{background:var(--delbg)}.st.M{background:var(--hl)}
.empty{padding:40px 16px;text-align:center;color:var(--muted)}
.btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--line-strong);border-radius:7px;background:var(--panel);color:var(--fg);font:500 13px var(--font);cursor:pointer;white-space:nowrap}
.btn:hover{text-decoration:none;background:var(--hover)}.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}.btn.primary:hover{filter:brightness(1.05);background:var(--accent)}
form.inline{display:inline;margin:0}
label{display:block;font-weight:600;font-size:13px;margin:16px 0 6px}label .muted{font-weight:400}
select,input[type=text],input[type=url],input[type=password],textarea{width:100%;min-height:34px;padding:6px 10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--panel);color:var(--fg);font:inherit;outline:none}
select:focus,input:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
textarea{font:12px ui-monospace,Menlo,monospace;min-height:90px}
.narrow{max-width:560px;margin:24px auto 0;padding:24px 28px 28px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.narrow form .btn{margin-top:18px}
.banner{border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:0 0 16px;background:var(--panel)}
.banner.err{border-color:transparent;background:var(--delbg);color:var(--D)}.banner.ok{border-color:transparent;background:var(--addbg);color:var(--A)}.banner form{margin-top:8px}
details.menu{position:relative;display:inline-block}details.menu>summary{list-style:none;cursor:pointer}details.menu>summary::-webkit-details-marker{display:none}
details.menu .pop{position:absolute;z-index:10;top:calc(100% + 6px);left:0;min-width:240px;max-width:340px;max-height:360px;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-lg);padding:6px}
.pop .h{padding:6px 10px 4px;font-size:11.5px;color:var(--faint);font-weight:600}.pop a{display:block;padding:6px 10px;border-radius:6px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pop a.on{font-weight:600;background:var(--selected)}.pop a:hover{background:var(--hover);text-decoration:none}
.md{padding:8px 32px 24px;word-wrap:break-word;line-height:1.65;font-size:15px}
.md h1,.md h2{border-bottom:1px solid var(--line);padding-bottom:.3em;margin:24px 0 16px;font-weight:650}.md h1{font-size:1.8em}.md h2{font-size:1.4em}.md h3{font-size:1.2em}
.md pre{background:var(--bg);border:1px solid var(--line);border-radius:8px}.md code{background:var(--fill);padding:.15em .35em;border-radius:4px}.md pre code{background:none;padding:0}
.md table{width:auto;margin:12px 0;display:block;overflow-x:auto}.md td,.md th{border:1px solid var(--line);padding:6px 13px}.md th{background:var(--bg)}
.md blockquote{margin:0 0 16px;padding:0 1em;color:var(--muted);border-left:3px solid var(--line-strong)}.md img{max-width:100%}
.img{padding:24px;text-align:center;background:var(--bg)}.img img{max-width:100%}
.guide-box{padding:18px 22px;margin-bottom:24px}.guide-lead{margin:0;font-size:15px;flex:1;min-width:240px;color:var(--muted)}
.guide-head{display:flex;gap:12px 24px;align-items:flex-start;flex-wrap:wrap;margin:0 0 14px}
/* The app's page pieces, as app/src/app.css draws them, for pages built like the app's (the guide). */
.page-title h1{margin:0}.page-title p{margin:3px 0 0;color:var(--muted)}
.section-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;margin:22px 0 10px;font-size:13px;font-weight:600;color:var(--muted)}.section-title>span{font-weight:400;font-size:12.5px;color:var(--faint)}
.rows{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}.rows>li+li{border-top:1px solid var(--line)}
.card-grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.card{display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.card-icon{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--fill);color:var(--muted)}
.card-text{display:grid;gap:2px;min-width:0}.card-text strong{font-weight:550}.card-text span{color:var(--muted);font-size:12px;line-height:1.5}
.command{display:flex;align-items:flex-start;gap:6px;padding:7px 6px 7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.command code{flex:1;min-width:0;padding:4px 0;font:12px/1.5 ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:all;background:none}
.icon-button{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:7px;background:none;color:var(--muted);cursor:pointer}.icon-button:hover{background:var(--hover);color:var(--fg)}.icon-button.done{color:var(--A)}
.icon-button svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
/* The guide: steps and questions are rows. */
.guide-page .tabs{margin:14px 0 18px}.guide-page section{scroll-margin-top:12px}
.guide-page :is(.step-main>span,.card-text span,.section-title>span,.faq-body p) code{padding:1px 5px;border-radius:4px;background:var(--fill);font-size:11.5px}
.steps{counter-reset:step}.step{counter-increment:step;display:flex;gap:12px;padding:11px 14px}
.step::before{content:counter(step);flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font:600 12px var(--font)}
.step-main{display:grid;gap:3px;flex:1;min-width:0}.step-main strong{font-weight:550;line-height:24px}.step-main>span{color:var(--muted);font-size:12.5px;line-height:1.55}.step-main .command{margin-top:5px}
.faq summary{padding:11px 14px;cursor:pointer;font-weight:550}.faq summary:hover{background:var(--hover)}
.faq-body{padding:0 14px 12px}.faq-body p{margin:0 0 8px;color:var(--muted);font-size:12.5px;line-height:1.55}
.guide{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.7fr) minmax(0,1fr);gap:12px 28px}@media (max-width:980px){.guide{grid-template-columns:minmax(0,1fr)}}
.guide h3{font-size:13px;font-weight:600;margin:0 0 6px}.guide ul,.guide ol{margin:0;padding-left:18px}.guide li{margin:0 0 6px}.guide p{margin:6px 0 0}.guide .clone{margin:4px 0 6px;white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:760px){body{grid-template:"top" 52px "main" minmax(0,1fr)/minmax(0,1fr)}aside.side{display:none}header .search{width:auto;margin-left:auto}header .search span,header .search kbd,header .spacer{display:none}main{padding:16px 16px 32px}.narrow{padding:18px}}
`;

const ICONS: Record<string, string> = {
  hub: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  guide: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  builders: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5M15 12H3"/>',
};
const icon = (name: string) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const avatar = (name: string, size: number) => `<img class="av" src="/-/avatar/${encodeURIComponent(name)}" width="${size}" height="${size}" alt="">`;

// The page frame, the app's own: a top bar (home, search, `nav`), the
// sidebar (`side`, '' for none) and <main>, which stays last in <body> for
// the live pages (cli/src/livepage.ts).
export function shell(title: string, nav: string, body: string, head = '', home = '/', side = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/-/app/theme.js"></script><script src="/-/app/copy.js" defer></script>${head}<title>${esc(title)}</title><link rel="icon" href="/-/app/quirq-icon.svg"><style>${CSS}</style></head><body${side ? '' : ' class="no-side"'}><header><a class="home" href="${esc(home)}" aria-label="spacehub home"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14"/><path transform="translate(15 9) scale(.34)" d="M50 0A50 50 0 0 1 100 50V118A14 14 0 0 1 86 132A14 14 0 0 1 72 118V94.87A50 50 0 1 1 50 0ZM50 33A17 17 0 1 0 50 67A17 17 0 1 0 50 33Z"/></svg>spacehub</a>${nav ? `<a class="search" href="/#search">${icon('search')}<span>Search spaces, projects, files</span><kbd>⌘K</kbd></a>` : ''}<span class="spacer"></span><nav>${nav}</nav></header>${side}<main>${body}</main></body></html>`;
}

// The top bar's right side for a viewer: a signed-in builder (its name) or anonymous (null).
export function navFor(viewer: string | null): string {
  if (!viewer) return `<a class="btn" href="/-/login">${icon('login')}Sign in</a>`;
  const me = encodeURIComponent(viewer);
  return `<details class="acct"><summary aria-label="Account">${avatar(viewer, 26)}${icon('down')}</summary><div class="pop"><div class="acct-head">${avatar(viewer, 32)}<div><b>${esc(viewer)}</b><span>Signed in</span></div></div><a href="/${me}">${icon('user')}Your profile</a><a href="/-/new">${icon('plus')}New project</a><a href="/-/guide">${icon('guide')}Guide</a><form method="post" action="/-/logout"><button type="submit">${icon('out')}Sign out</button></form></div></details>`;
}

// The sidebar of the server-rendered pages, built like the app's: where you
// are, the main places, and the hub's pages pinned to the bottom.
export function sideFor(viewer: string | null, current: 'home' | 'guide' | 'builders' | 'me' | '' = ''): string {
  const item = (key: string, href: string, label: string, iconName: string, extra = '') => `<a href="${href}"${key === current ? ' class="on" aria-current="page"' : ''}>${icon(iconName)}${esc(label)}${extra}</a>`;
  const mine = viewer ? item('me', `/${encodeURIComponent(viewer)}`, 'Your profile', 'user') : '';
  return `<aside class="side" aria-label="Navigation"><a class="hub" href="/"><i>${icon('home')}</i><span><b>All spaces</b><span>This hub</span></span></a><div class="group">${item('home', '/', 'Home', 'home')}${item('', '/#search', 'Search', 'search', '<kbd>⌘K</kbd>')}${mine}</div><div class="grow"></div><div class="foot">${item('guide', '/-/guide', 'Guide', 'guide')}${item('builders', '/-/builders', 'Builders', 'builders')}</div></aside>`;
}

// Scripts and connections only to this site: /-/live.js and its stream.
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
