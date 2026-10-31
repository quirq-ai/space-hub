// The hub's guide: get started in five steps, the words it uses, then one
// section per thing people do (work together, agents, GitHub, plain git) and
// what to do when something goes wrong. One source for both the full page
// (/-/guide) and the short version at the top of the module's home page. Keep
// it plain and short; the README has the rest.
//
// It is built from the app's pieces (style.ts ports them from app/src/app.css):
// a page title, tabs, small section titles, rows and cards, so it looks like
// the home page. Every command sits in a .command block; /-/app/copy.js adds
// the copy button (the page's CSP allows same-origin scripts only), and
// without JavaScript a click still selects the whole command.
//
// HUB is the remote name and URL scheme git uses (quirq, quirq://<host>/<space>/<project>).
// The sign-in wording follows the hub's accounts setting: open (register a
// name) or github (sign in with GitHub from the CLI).
// TODO: on a hub whose accounts are xo (SPACEHUB_ACCOUNTS=xo), builders come from xo login instead.
import { esc } from './style';
import { cmd, INSTALL_CLI, INSTALL_XO, loginCommand, step, steps, xoSignsIn } from './howto';

const HUB = {
  cli: 'spacehub',
  remote: 'quirq',
  // The git URL of a project: it names the hub, so it works whichever hub the CLI is logged in to.
  url: (host: string, project: string) => `quirq://${host}/${project}`,
};

export interface GuideContext {
  server: string; // ws:// or wss:// address of this hub
  host: string;
  link: (path: string) => string; // a UI path, as the page links it
  accounts: string; // "open", "github" or "xo" (hub_state)
}


function commands(ctx: GuideContext) {
  const c = HUB.cli;
  return {
    install: INSTALL_CLI,
    installXo: INSTALL_XO,
    login: loginCommand(ctx),
    gh: 'gh auth login',
    create: `${c} project create <name> --source . --push`,
    clone: `${c} project clone <you>/<name>`,
    autosync: `${c} project sync --watch --auto`,
    org: `${c} space create <org>`,
    orgMember: `${c} space member add <org> <builder>`,
    collaborator: `${c} project member add <space>/<project> <builder>`,
    orgProject: `${c} project create <org>/<name> --source . --push`,
    orgClone: `${c} project clone <org>/<name>`,
    who: `${c} project who <org>/<name>`,
    spaceClone: `${c} space clone <org>`,
    spaceSync: `${c} space sync --watch --auto`,
    agentCreate: `${c} agent create <agent> -d "what it does"`,
    agentConnect: `${c} agent connect <agent> <space>`,
    agentRun: `${c} agent run <agent>`,
    agentToken: `${c} agent token <agent>`,
    watch: `${c} project watch <space>/<project> --exec "<command>"`,
    link: `${c} space link <space> https://github.com/<account>`,
    gitClone: `git clone -o ${HUB.remote} ${HUB.url(ctx.host, '<space>/<project>')}`,
    gitPush: `git push ${HUB.remote} main`,
    gitPull: `git pull ${HUB.remote} main`,
    resolve: 'git add <files> && git rebase --continue',
    ignored: 'git check-ignore -v <file>',
    token: `${c} auth token`,
  };
}

const LEAD =
  'spacehub keeps git projects that people and AI agents share. Push with plain git, and every connected copy gets the change within seconds.';

// The short version for the module's home page.
export function guideHome(ctx: GuideContext): string {
  const c = commands(ctx);
  const github = ctx.accounts === 'github';
  return `<div class="box guide-box"><div class="guide-head"><p class="guide-lead">${esc(LEAD)}</p><a class="btn" href="${esc(ctx.link('-/guide'))}">Read the guide</a></div>
<div class="guide">
<div><h3>Who can use it</h3><ul>
<li>Anyone can browse spaces and projects and clone them.</li>
<li>To create projects or push, you need a builder login. ${github ? 'Sign in with your GitHub account from the CLI: your builder name is your GitHub login.' : 'Register on the <a href="/-/signup">sign-up page</a>, or with the CLI.'}</li></ul></div>
<div><h3>Get started</h3><ol>
<li>Install the CLI (needs git and Node 22+):${cmd(c.install)}</li>
<li>Sign in:${cmd(c.login)}</li>
<li>Share a repo (run inside it):${cmd(c.create)}</li></ol></div>
<div><h3>Use cases</h3><ul>
<li>Keep one repo the same on your laptop, cloud machines and AI agents.</li>
<li>Hand work between people and agents in seconds.</li>
<li>Work in one project with others at the same time: see <a href="${esc(ctx.link('-/guide'))}#together">Work together</a>.</li>
<li>Mirror GitHub repos or whole organizations here and keep them updated.</li></ul></div>
</div></div>`;
}

// Small line icons for the cards, drawn like the app's (lucide) icons.
const ICON = {
  layout: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7M18 11.5c0 3-3 4-9.5 5.5"/>',
  live: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
};
const svg = (name: keyof typeof ICON) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

// A card: an icon or nothing, a title and one line.
const card = (title: string, text: string, icon?: keyof typeof ICON) =>
  `<li class="card">${icon ? `<span class="card-icon">${svg(icon)}</span>` : ''}<span class="card-text"><strong>${title}</strong><span>${text}</span></span></li>`;


// A question that opens to its answer, as a row.
const faq = (question: string, answer: string, ...blocks: string[]) =>
  `<li><details><summary>${question}</summary><div class="faq-body"><p>${answer}</p>${blocks.join('')}</div></details></li>`;

// The full guide page.
export function guidePage(ctx: GuideContext): string {
  const c = commands(ctx);
  const github = ctx.accounts === 'github';
  const xo = xoSignsIn(ctx)
    ? `<p class="or">Use XO? Sign in with xo instead: one login for XO and this hub, as the GitHub account connected to XO. It needs Python 3.11 or newer.</p>${cmd(c.installXo, 'xo login')}`
    : '';
  const signIn = github
    ? step(
        'Sign in',
        `With your GitHub account: your builder name, and your personal space, are your GitHub login. If it asks you to log in to GitHub first, run <code>${esc(c.gh)}</code> and try again.`,
        cmd(c.login),
        xo
      )
    : step('Pick a builder name', 'It becomes your personal space. The CLI saves your token: there is no password.', cmd(c.login), xo);
  const sections = [
    ['start', 'Get started'],
    ['words', 'Words to know'],
    ['together', 'Work together'],
    ['agents', 'Agents'],
    ['github', 'GitHub'],
    ['git', 'Plain git'],
    ['help', 'Help'],
  ];
  return `<div class="guide-page">
<div class="page-title"><h1>Guide</h1><p>${esc(LEAD)}</p></div>
<nav class="tabs" aria-label="On this page">${sections.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</nav>

<ul class="card-grid">
${card('Laid out like GitHub', 'Spaces hold projects, the way accounts hold repositories.', 'layout')}
${card('Plain git', `Push and pull through the <code>${HUB.remote}</code> remote. <code>origin</code> stays yours.`, 'git')}
${card('Live', 'Every connected copy, person or agent, gets each push within seconds.', 'live')}
</ul>

<section id="start"><h2 class="section-title">Get started <span>Five steps, a couple of minutes. You need git and Node 22 or newer.</span></h2>
${steps(
  step('Install the CLI', `It puts <code>${HUB.cli}</code> and git's <code>${HUB.remote}</code> helper on your PATH. Run it again any time to update.`, cmd(c.install)),
  signIn,
  step('Share a repo', 'Run it inside the repo. Its page here is <code>/&lt;you&gt;/&lt;name&gt;</code>.', cmd('cd path/to/your-repo', c.create)),
  step('Get it on another machine', 'A laptop, a cloud machine or an agent: sign in there too, then clone.', cmd(c.clone)),
  step('Keep every copy in sync', "Run it inside each clone and leave it running. Every few seconds it commits your changes, new files included, takes in everyone else's pushes and pushes yours.", cmd(c.autosync))
)}
</section>

<section id="words"><h2 class="section-title">Words to know</h2>
<ul class="card-grid">
${card('Space', 'A name at the top of the hub, <code>/&lt;space&gt;</code>: a builder, an org or an agent.')}
${card('Project', 'A git repository in a space, <code>/&lt;space&gt;/&lt;project&gt;</code>.')}
${card('Org', 'A space for a team. Members push to all its projects; owners manage it.')}
${card('Builder', github ? 'A person with a login. The name is their GitHub login.' : 'A person with a login, under the name they registered.')}
${card('Agent', 'A space with its own identity. Its instructions and memory live in <code>&lt;agent&gt;/home</code>.')}
${card('Activity', 'Every change on the hub, newest first: pushes, projects, members, imports.')}
</ul>
</section>

<section id="together"><h2 class="section-title">Work together <span>Several people and agents can edit one project at once. Autosync keeps their clones the same.</span></h2>
${steps(
  step('Make an org', 'You become its owner.', cmd(c.org)),
  step('Add people', `Members push to every project of the org. To let someone push to one project only, make them a collaborator: <code>${esc(c.collaborator)}</code>`, cmd(c.orgMember)),
  step('Put a project in it', 'Run it inside the repo.', cmd(c.orgProject)),
  step('Everyone clones it and starts autosync', 'Edits to different files never need a manual pull.', cmd(c.orgClone, `cd <name> && ${c.autosync}`)),
  step('See who is working right now', 'The project page shows them too.', cmd(c.who)),
  step('Or work on every project of the org at once', 'One folder, one command; new projects appear by themselves.', cmd(c.spaceClone, `cd <org> && ${c.spaceSync}`))
)}
</section>

<section id="agents"><h2 class="section-title">Agents <span>An agent works in your spaces under its own name: its commits and pushes are credited to it.</span></h2>
${steps(
  step('Create it', 'Its home project holds its instructions, memory and skills.', cmd(c.agentCreate)),
  step('Let it work in a space', 'You must own both.', cmd(c.agentConnect)),
  step('Run it', 'On any machine. It keeps its home and every connected space in one folder, in sync.', cmd(c.agentRun)),
  step('Run it somewhere else', 'XO Swarm or another machine launches it with its token.', cmd(c.agentToken)),
  step('Hand work over', 'Run a command every time a project gets a push.', cmd(c.watch))
)}
</section>

<section id="github"><h2 class="section-title">GitHub</h2>
${steps(
  step('Import one repo', 'Click <b>New project</b> and paste the GitHub URL. <b>Sync from GitHub</b> on the project pulls later changes.'),
  step('Mirror a whole account', 'Every public repository becomes a project with the same name, kept in step every hour. Work done here is never overwritten.', cmd(c.link))
)}
</section>

<section id="git"><h2 class="section-title">Plain git <span>Once the CLI is installed, git understands the hub's addresses. The remote is <code>${HUB.remote}</code>, so <code>origin</code> stays free for GitHub.</span></h2>
${steps(step('Clone', '', cmd(c.gitClone)), step('Push', '', cmd(c.gitPush)), step('Pull', '', cmd(c.gitPull)))}
</section>

<section id="help"><h2 class="section-title">If something goes wrong</h2>
<ul class="rows faq">
${faq('The CLI says it is out of date', 'The hub was updated. Run the install command again; your login stays.', cmd(c.install))}
${faq('Autosync stopped on a conflict', 'You and someone else changed the same lines. Your autosync stopped and listed the files; everyone else keeps going. Fix the files, continue the rebase and start autosync again. <code>git rebase --abort</code> keeps your commits as they were instead.', cmd(c.resolve, c.autosync))}
${faq('A new file did not sync', 'Check that autosync is running in that clone, and that git is not ignoring the file:', cmd(c.ignored))}
${faq('Sign in on this website', 'Sign in from your terminal first (with spacehub or xo), then print your token and paste it at <b>Sign in</b>.', cmd(c.token))}
${faq('Who can see and change my projects?', "Anyone who can open this hub can browse and clone every project. Only a space's owners and members, and a project's collaborators, can push.")}
</ul>
</section>
</div>`;
}
