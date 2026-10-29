// Copy buttons for command blocks on the hub's server-rendered pages
// (<div class="cmd"><code class="clone">...</code></div>, e.g. the guide).
// A separate file because those pages allow same-origin scripts only. Without
// it, a click on the command still selects all of it.
(() => {
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const DONE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function fallback(code) {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      selection.removeAllRanges();
    }
  }

  async function copy(code) {
    const text = code.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return fallback(code);
    }
  }

  function enhance(block) {
    const code = block.querySelector('.clone');
    if (!code || block.querySelector('.copy')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.setAttribute('aria-label', 'Copy command');
    button.innerHTML = `${ICON}<span>Copy</span>`;
    let timer = 0;
    button.addEventListener('click', async () => {
      const ok = await copy(code);
      button.classList.toggle('done', ok);
      button.innerHTML = ok ? `${DONE}<span>Copied</span>` : `${ICON}<span>Press ${/Mac|iP/.test(navigator.platform) ? '⌘C' : 'Ctrl+C'}</span>`;
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.classList.remove('done');
        button.innerHTML = `${ICON}<span>Copy</span>`;
      }, 1600);
    });
    block.classList.add('copyable');
    block.append(button);
  }

  const run = () => document.querySelectorAll('.cmd').forEach(enhance);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
