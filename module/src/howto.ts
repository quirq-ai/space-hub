// Pieces for pages that show how to do something: command blocks, numbered
// steps, and the ways to sign in. One source for the guide (module) and the
// web service's sign-in and sign-up pages, so they never disagree. They are
// drawn with the app's classes (style.ts); /-/app/copy.js adds the copy button
// to every .command.
import { esc } from './style';

// The hub the spacehub CLI talks to when no --server is given, and the one the
// xo server hands its users' builders to (xo login).
export const DEFAULT_HOST = 'hub.quirq.dev';

export const INSTALL_CLI = 'd="$(mktemp -d)" && git clone -q --depth 1 https://github.com/quirq-ai/space-hub "$d" && "$d/scripts/install-cli.sh"';
// xo, XO's command line (github.com/quirq-ai/xo). Its package is quirq-xo: PyPI's "xo" is something else.
export const INSTALL_XO = 'pip install "quirq-xo @ git+https://github.com/quirq-ai/xo"';

// One or more command lines, copied together.
export const cmd = (...lines: string[]) => `<div class="command"><code>${esc(lines.join('\n'))}</code></div>`;

// A numbered step, as a row: a title, what it does, and the commands to run.
export const step = (title: string, text: string, ...blocks: string[]) =>
  `<li class="step"><div class="step-main"><strong>${title}</strong>${text ? `<span>${text}</span>` : ''}${blocks.join('')}</div></li>`;
export const steps = (...items: string[]) => `<ol class="rows steps">${items.join('')}</ol>`;

export interface Hub {
  server: string; // ws:// or wss:// address
  host: string;
  accounts: string; // "open", "github" or "xo"
  xo?: boolean; // this website signs in with xo too (the web service asks the xo server)
  github?: boolean; // this website signs in with GitHub (the hub's OAuth App)
}

// `spacehub auth login` for this hub: --server only when it is not the default.
export function loginCommand(hub: Hub) {
  const server = hub.host === DEFAULT_HOST ? '' : ` --server ${hub.server}`;
  return hub.accounts === 'github' ? `spacehub auth login${server}` : `spacehub auth login${server} --builder <name>`;
}

// xo login hands its users' builders to the hub the xo server keeps: this one
// only if it is that hub, or if its builders come from xo.
export const xoSignsIn = (hub: Hub) => hub.host === DEFAULT_HOST || hub.accounts === 'xo';

// One click on this website: with GitHub (githubsignin.ts in the web service,
// shown while the hub has its OAuth App), or through XO's own sign-in
// (xosignin.ts, shown while the xo server offers it to this hub). Either way
// the account is the GitHub account's builder; xo adds the XO username as its
// display name, and launching agents needs it.
export function signInButtons(hub: Hub, verb: 'Sign in' | 'Sign up', next: string, or = 'Or from the terminal') {
  if (!hub.github && !hub.xo) return '';
  const query = next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  const github = hub.github
    ? `<div class="xo-signin"><a class="btn primary" href="${esc(`/-/login/github${query}`)}">${verb} with GitHub</a><span>Your builder name is your GitHub login.</span></div>`
    : '';
  const xo = hub.xo
    ? `<div class="xo-signin"><a class="btn${hub.github ? '' : ' primary'}" href="${esc(`/-/login/xo${query}`)}">${verb} with xo</a><span>Uses your XO account and the GitHub account connected to it: your builder name is your GitHub login, and your XO username its display name. Launching agents needs it.</span></div>`
    : '';
  return `${github}${xo}<h2 class="section-title or-terminal">${esc(or)}</h2>`;
}

// Every way to sign in to this hub, side by side. forWebsite adds the last
// step of each: print the token to paste into this site's sign-in form.
export function signInWays(hub: Hub, forWebsite: boolean) {
  const token = forWebsite ? [step('Print your token', 'Paste it below.', cmd('spacehub auth token'))] : [];
  const xo = `<section class="way"><h2 class="section-title">With xo <span>Use XO? One login for XO and this hub. Your builder name is the GitHub login connected to your XO account.</span></h2>
${steps(
  step("Install the hub's CLI and xo", 'Needs git, Node 22 or newer and Python 3.11 or newer.', cmd(INSTALL_CLI, INSTALL_XO)),
  step('Log in', 'It signs you in to XO and hands your hub builder to spacehub.', cmd('xo login')),
  ...token
)}</section>`;
  const cli =
    hub.accounts === 'github'
      ? `<section class="way"><h2 class="section-title">With GitHub <span>Your builder name is your GitHub login.</span></h2>
${steps(
  step("Install the hub's CLI", 'Needs git and Node 22 or newer.', cmd(INSTALL_CLI)),
  step('Log in', 'The first time, it makes your builder. If it asks you to log in to GitHub first, run <code>gh auth login</code> and try again.', cmd(loginCommand(hub))),
  ...token
)}</section>`
      : hub.accounts === 'open'
        ? `<section class="way"><h2 class="section-title">With a builder name <span>Pick a name once; the CLI keeps your token.</span></h2>
${steps(
  step("Install the hub's CLI", 'Needs git and Node 22 or newer.', cmd(INSTALL_CLI)),
  step('Log in', 'The first time, it registers the name. You can also <a href="/-/signup">register here</a>.', cmd(loginCommand(hub))),
  ...token
)}</section>`
        : '';
  return `<div class="ways">${cli}${xoSignsIn(hub) ? xo : ''}</div>`;
}
