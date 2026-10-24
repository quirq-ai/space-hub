// What the browser side of live pages needs, free of the SDK so tests can
// load it: the page script, which pages are live, and the parts of a
// rendered page that the script swaps in. See live.ts.

export const LIVE_JS = `(function () {
  var main = document.querySelector('main');
  if (!main || !window.EventSource) return;
  var nav = document.querySelector('header nav');
  var dot = document.createElement('span');
  dot.className = 'live off';
  dot.textContent = 'live';
  dot.title = 'This page updates as the hub changes';
  if (nav) nav.insertBefore(dot, nav.firstChild);
  var waiting = null;
  function apply(page) {
    main.innerHTML = page.main;
    document.title = page.title;
  }
  // Keep a menu the reader has open; swap once it closes.
  document.addEventListener('toggle', function () {
    if (waiting && !main.querySelector('details[open]')) { apply(waiting); waiting = null; }
  }, true);
  var source = new EventSource('/-/live?path=' + encodeURIComponent(location.pathname + location.search));
  source.onopen = function () { dot.className = 'live'; };
  source.onerror = function () { dot.className = 'live off'; };
  var first = true;
  source.addEventListener('page', function (e) {
    var page = JSON.parse(e.data);
    // The first event catches up with changes made while the page loaded;
    // usually there are none, so leave the page (and any selection) alone.
    if (first) {
      first = false;
      var fresh = document.createElement('template');
      fresh.innerHTML = page.main;
      if (fresh.content.textContent === main.textContent) return;
    }
    if (main.querySelector('details[open]')) waiting = page;
    else apply(page);
  });
})();
`;

// Which changes a page follows: the home page everything, an agent's page
// that agent, a space's pages that space. Pages that never change, and
// anything outside the UI, are not live.
export function liveTopic(target: string): string | null {
  if (target.length > 2048) return null;
  const pathname = target.split('?')[0];
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.startsWith('/-/')) return null;
  let segs: string[];
  try {
    segs = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segs.length === 0) return 'hub';
  if (segs[0] === 'guide' || segs[0] === 'builders' || segs[2] === 'raw') return null;
  if (segs.length === 1) return `agent:${segs[0]}`;
  return `space:${segs[0]}/${segs[1]}`;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

// The parts of a rendered page that live.js swaps: its title and <main>.
export function pageParts(html: string): { title: string; main: string } | null {
  const main = /<main>([\s\S]*)<\/main><\/body><\/html>\s*$/.exec(html);
  if (!main) return null;
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '';
  return { title: title.replace(/&(amp|lt|gt|quot|#39);/g, m => ENTITIES[m]), main: main[1] };
}
