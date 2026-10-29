// Copy buttons for command blocks on the hub's server-rendered pages
// (<div class="command"><code>...</code></div>, e.g. the guide), drawn like
// the app's CopyButton. A separate file because those pages allow same-origin
// scripts only. Without it, a click on the command still selects all of it.
(() => {
  const COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const KEYS = /Mac|iP/.test(navigator.platform) ? '⌘C' : 'Ctrl+C';

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
    try {
      await navigator.clipboard.writeText(code.textContent || '');
      return true;
    } catch {
      return fallback(code);
    }
  }

  function enhance(block) {
    const code = block.querySelector('code');
    if (!code || block.querySelector('.icon-button')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button';
    button.setAttribute('aria-label', 'Copy command');
    button.title = 'Copy command';
    button.innerHTML = COPY;
    let timer = 0;
    button.addEventListener('click', async () => {
      const ok = await copy(code);
      button.classList.toggle('done', ok);
      button.innerHTML = ok ? CHECK : COPY;
      button.title = ok ? 'Copied' : `Press ${KEYS} to copy`;
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.classList.remove('done');
        button.innerHTML = COPY;
        button.title = 'Copy command';
      }, 1500);
    });
    block.append(button);
  }

  const run = () => document.querySelectorAll('.command').forEach(enhance);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
