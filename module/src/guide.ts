// The hub's guide: get started in five steps, the words it uses, then one
// section per thing people do (work together, agents, GitHub, plain git) and
// what to do when something goes wrong. One source for both the full page
// (/-/guide) and the short version at the top of the module's home page. Keep
// it plain and short; the README has the rest.
//
// Every command sits in a .cmd block; /-/app/copy.js adds a Copy button to
// each (the page's CSP allows same-origin scripts only), and without
// JavaScript the command is still selectable in one click.
//
// HUB is the remote name and URL scheme git uses (quirq, quirq://<host>/<space>/<project>).
// The sign-in wording follows the hub's accounts setting: open (register a
// name) or github (sign in with GitHub from the CLI).
// TODO: on a hub whose accounts are xo (SPACEHUB_ACCOUNTS=xo), builders come from xo login instead.
import { esc } from './style';

const HUB = {
  cli: 'spacehub',
  remote: 'quirq',
  source: 'https://github.com/quirq-ai/space-hub',
  // The hub the CLI talks to when no --server is given.
  defaultHost: 'hub.quirq.dev',
  // The git URL of a project: it names the hub, so it works whichever hub the CLI is logged in to.
  url: (host: string, project: string) => `quirq://${host}/${project}`,
};

export interface GuideContext {
  server: string; // ws:// or wss:// address of this hub
  host: string;
  link: (path: string) => string; // a UI path, as the page links it
  accounts: string; // "open", "github" or "xo" (hub_state)
}

// One or more command lines, copied together.
const cmd = (...lines: string[]) => `<div class="cmd"><code class="clone">${esc(lines.join('\n'))}</code></div>`;

function commands(ctx: GuideContext) {
  const c = HUB.cli;
  const server = ctx.host === HUB.defaultHost ? '' : ` --server ${ctx.server}`;
  return {
    install: `d="$(mktemp -d)" && git clone -q --depth 1 ${HUB.source} "$d" && "$d/scripts/install-cli.sh"`,
    login: ctx.accounts === 'github' ? `${c} auth login${server}` : `${c} auth login${server} --builder <name>`,
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

// A numbered step: a title, what it does, and the commands to run.
const step = (title: string, text: string, ...blocks: string[]) => `<li><h3>${title}</h3>${text ? `<p>${text}</p>` : ''}${blocks.join('')}</li>`;

// The full guide page.
export function guidePage(ctx: GuideContext): string {
  const c = commands(ctx);
  const github = ctx.accounts === 'github';
  const signIn = github
    ? step(
        'Sign in with GitHub',
        `Your builder name, and your personal space, are your GitHub login. If it asks you to log in to GitHub first, run <code>${esc(c.gh)}</code> and try again.`,
        cmd(c.login)
      )
    : step('Pick a builder name', 'It becomes your personal space. The CLI saves your token: there is no password.', cmd(c.login));
  const sections = [
    ['start', 'Get started'],
    ['words', 'Words to know'],
    ['together', 'Work together'],
    ['agents', 'Agents'],
    ['github', 'GitHub'],
    ['git', 'Plain git'],
    ['help', 'If something goes wrong'],
  ];
  return `<div class="guide-page">
<h1><b>Guide</b></h1>
<p class="desc">${esc(LEAD)}</p>
<div class="glance">
<div><b>Laid out like GitHub</b><span>Spaces hold projects, the way accounts hold repositories.</span></div>
<div><b>Plain git</b><span>Push and pull through the <code>${HUB.remote}</code> remote. <code>origin</code> stays yours.</span></div>
<div><b>Live</b><span>Every connected copy, person or agent, gets each push within seconds.</span></div>
</div>
<div class="guide-layout">
<nav class="toc" aria-label="On this page">${sections.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</nav>
<div class="guide-body">

<section id="start"><h2>Get started</h2>
<p class="lede">Five steps, a couple of minutes. You need git and Node 22 or newer.</p>
<ol class="steps">
${step('Install the CLI', `It puts <code>${HUB.cli}</code> and git's <code>${HUB.remote}</code> helper on your PATH. Run it again any time to update.`, cmd(c.install))}
${signIn}
${step('Share a repo', `Run it inside the repo. Its page here is <code>/&lt;you&gt;/&lt;name&gt;</code>.`, cmd('cd path/to/your-repo', c.create))}
${step('Get it on another machine', 'A laptop, a cloud machine or an agent: sign in there too, then clone.', cmd(c.clone))}
${step('Keep every copy in sync', 'Run it inside each clone and leave it running. Every few seconds it commits your changes, new files included, takes in everyone else\'s pushes and pushes yours.', cmd(c.autosync))}
</ol>
<p class="done">That's it: an edit on any machine reaches the others within seconds.</p>
</section>

<section id="words"><h2>Words to know</h2>
<div class="words">
<div><b>Space</b><span>A name at the top of the hub, <code>/&lt;space&gt;</code>: a builder's personal space, an org or an agent.</span></div>
<div><b>Project</b><span>A git repository in a space, <code>/&lt;space&gt;/&lt;project&gt;</code>.</span></div>
<div><b>Org</b><span>A space for a team. Its members push to all of its projects; its owners manage it.</span></div>
<div><b>Builder</b><span>A person with a login. ${github ? 'The name is their GitHub login.' : 'The name is the one they registered.'}</span></div>
<div><b>Agent</b><span>A space with its own identity. Its instructions and memory live in <code>&lt;agent&gt;/home</code>.</span></div>
<div><b>Activity</b><span>Every change on the hub, newest first: pushes, new projects, members and imports.</span></div>
</div>
</section>

<section id="together"><h2>Work together</h2>
<p class="lede">Several people and agents can edit one project at the same time. Each works in their own clone; autosync keeps the clones the same.</p>
<ol class="steps">
${step('Make an org', 'You become its owner.', cmd(c.org))}
${step('Add people', `Members push to every project of the org. To let someone push to one project only, make them a collaborator: <code>${esc(c.collaborator)}</code>`, cmd(c.orgMember))}
${step('Put a project in it', 'Run it inside the repo.', cmd(c.orgProject))}
${step('Everyone clones it and starts autosync', 'Edits to different files never need a manual pull.', cmd(c.orgClone, `cd <name> && ${c.autosync}`))}
</ol>
<p>See who is working right now, here or on the project's page:</p>${cmd(c.who)}
<p>Work on every project of the org at once: one folder, one command, and new projects appear by themselves.</p>${cmd(c.spaceClone, `cd <org> && ${c.spaceSync}`)}
</section>

<section id="agents"><h2>Agents</h2>
<p class="lede">An agent works in your spaces under its own name: its commits and pushes are credited to it.</p>
<ol class="steps">
${step('Create it', 'Its home project holds its instructions, memory and skills.', cmd(c.agentCreate))}
${step('Let it work in a space', 'You must own both.', cmd(c.agentConnect))}
${step('Run it', 'On any machine. It keeps its home and every connected space in one folder, in sync.', cmd(c.agentRun))}
</ol>
<p>To launch it somewhere else, such as XO Swarm, give it its token:</p>${cmd(c.agentToken)}
<p>Hand work over: run a command every time a project gets a push.</p>${cmd(c.watch)}
</section>

<section id="github"><h2>GitHub</h2>
<div class="words two">
<div><b>Import one repo</b><span>Click <b>New project</b> and paste the GitHub URL. <b>Sync from GitHub</b> on the project pulls later changes.</span></div>
<div><b>Mirror a whole account</b><span>Every public repository becomes a project with the same name, kept in step every hour. Work done here is never overwritten.</span></div>
</div>
${cmd(c.link)}
</section>

<section id="git"><h2>Plain git</h2>
<p class="lede">Once the CLI is installed, git understands the hub's addresses. The hub's remote is called <code>${HUB.remote}</code>, so <code>origin</code> stays free for GitHub.</p>
${cmd(c.gitClone)}${cmd(c.gitPush)}${cmd(c.gitPull)}
</section>

<section id="help"><h2>If something goes wrong</h2>
<div class="faq">
<details><summary>The CLI says it is out of date</summary><p>The hub was updated. Run the install command again; your login stays.</p>${cmd(c.install)}</details>
<details><summary>Autosync stopped on a conflict</summary><p>You and someone else changed the same lines. Your autosync stopped and listed the files; everyone else keeps going. Fix the files, then continue the rebase and start autosync again. <code>git rebase --abort</code> keeps your commits as they were instead.</p>${cmd(c.resolve, c.autosync)}</details>
<details><summary>A new file did not sync</summary><p>Check that autosync is running in that clone, and that git is not ignoring the file:</p>${cmd(c.ignored)}</details>
<details><summary>Sign in on this website</summary><p>Print your token and paste it at <b>Sign in</b>.</p>${cmd(c.token)}</details>
<details><summary>Who can see and change my projects?</summary><p>Anyone who can open this hub can browse and clone every project. Only a space's owners and members, and a project's collaborators, can push.</p></details>
</div>
</section>

</div>
</div>
</div>`;
}
