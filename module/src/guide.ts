// The hub's guide: what it is, who can use it, how to use it, use cases.
// One source for both the full page (/-/guide) and the short version at the
// top of the home page. Keep it plain and short; the README has the rest.
//
// HUB is the remote name and URL scheme git uses (quirq, quirq://<host>/<space>/<project>).
// TODO: the sign-in wording still says anyone can register; on a hub that
// serves xo (SPACEHUB_XO_KEY), builders come from xo login instead.
import { esc } from './style';

const HUB = {
  cli: 'spacehub',
  remote: 'quirq',
  source: 'https://github.com/quirq-ai/space-hub',
  // The git URL of a project: it names the hub, so it works whichever hub the CLI is logged in to.
  url: (host: string, project: string) => `quirq://${host}/${project}`,
};

export interface GuideContext {
  server: string; // ws:// or wss:// address of this hub
  host: string;
  link: (path: string) => string; // a UI path, as the page links it
}

const code = (text: string) => `<code class="clone">${esc(text)}</code>`;

function commands(ctx: GuideContext) {
  const c = HUB.cli;
  return {
    install: `git clone ${HUB.source} && ./space-hub/scripts/install-cli.sh`,
    login: `${c} auth login --server ${ctx.server} --builder <name>`,
    create: `${c} project create <name> --source . --push`,
    team: `${c} space create <team>`,
    teamMember: `${c} space member add <team> <builder>`,
    teamProject: `${c} project create <team>/<name> --source . --push`,
    clone: `${c} project clone <space>/<project>`,
    sync: `${c} project sync --watch`,
    watch: `${c} project watch <space>/<project> --exec "<command>"`,
    collaborator: `${c} project member add <space>/<project> <builder>`,
    link: `${c} space link <space> https://github.com/<account>`,
    spaceClone: `${c} space clone <space>`,
    spaceSync: `cd <space> && ${c} space sync --watch --auto`,
    autosync: `${c} project sync --watch --auto`,
    who: `${c} project who <space>/<project>`,
    members: `${c} space member list <team>`,
    leave: `${c} space member remove <team> <your name>`,
    interval: `${c} project sync --watch --auto --interval 10`,
    resolve: 'git add <files> && git rebase --continue',
    gitRebase: `git pull --rebase ${HUB.remote} main && git push ${HUB.remote} main`,
    token: `${c} auth token`,
    gitClone: `git clone -o ${HUB.remote} ${HUB.url(ctx.host, '<space>/<project>')}`,
    gitPush: `git push ${HUB.remote} main`,
    gitPull: `git pull ${HUB.remote} main`,
  };
}

const LEAD =
  'spacehub keeps git projects that people and AI agents share, grouped into spaces like GitHub organizations. Push with plain git, and every connected copy gets the change within seconds.';

// The short version for the home page.
export function guideHome(ctx: GuideContext): string {
  const cmd = commands(ctx);
  return `<div class="box guide-box"><div class="guide-head"><p class="guide-lead">${esc(LEAD)}</p><a class="btn" href="${esc(ctx.link('-/guide'))}">Read the guide</a></div>
<div class="guide">
<div><h3>Who can use it</h3><ul>
<li>Anyone can browse spaces and projects and clone them.</li>
<li>To create projects or push, you need a builder login. Register at the top right, or with the CLI.</li></ul></div>
<div><h3>Get started</h3><ol>
<li>Install the CLI (needs git and Node 22+):${code(cmd.install)}</li>
<li>Log in as a builder:${code(cmd.login)}</li>
<li>Share a repo (run inside it):${code(cmd.create)}</li></ol></div>
<div><h3>Use cases</h3><ul>
<li>Keep one repo the same on your laptop, cloud machines and AI agents.</li>
<li>Hand work between people and agents in seconds.</li>
<li>Work in one project with others at the same time: see <a href="${esc(ctx.link('-/guide'))}#together">Edit together</a>.</li>
<li>Mirror GitHub repos or whole organizations here and keep them updated.</li></ul></div>
</div></div>`;
}

// The full guide page.
export function guidePage(ctx: GuideContext): string {
  const cmd = commands(ctx);
  const step = (text: string, command?: string) => `<li>${text}${command ? code(command) : ''}</li>`;
  return `<div class="guide-page">
<h1><b>Guide</b></h1>
<p class="desc">${esc(LEAD)}</p>
<nav class="toc"><a href="#what">What it is</a><a href="#who">Who can use it</a><a href="#how">How to use it</a><a href="#together">Edit together</a><a href="#use-cases">Use cases</a></nav>

<section id="what"><h2>What it is</h2>
<p>A hub for git repositories, laid out like GitHub. You use plain git to push and pull. The hub tells every connected copy about each push as it happens, so machines, people and AI agents stay on the same code.</p>
<dl class="terms">
<dt>Space</dt><dd>A name at the top of the hub, <code>/&lt;space&gt;</code>, like a GitHub user or organization. A builder's personal space has the builder's name; a team space groups projects for several builders.</dd>
<dt>Project</dt><dd>A git repository in a space, <code>/&lt;space&gt;/&lt;project&gt;</code>, like a GitHub repository.</dd>
<dt>Builder</dt><dd>A person with a login here. Builders also means who made a project's code: GitHub accounts show as builders for the repos imported from them.</dd>
<dt>Member</dt><dd>Belongs to a team space and pushes to all of its projects. Owners also manage the space.</dd>
<dt>Collaborator</dt><dd>May push to one project outside their own spaces.</dd>
<dt>Activity</dt><dd>The log of every change on the hub: pushes, new projects and spaces, imports and edits.</dd>
</dl></section>

<section id="who"><h2>Who can use it</h2><ul>
<li><b>Anyone</b> who can open this page can browse every space and project, read the activity and clone any project.</li>
<li><b>Builders</b> can also create projects and team spaces, push and import from GitHub. Register at the top right, or with ${code(cmd.login)}</li>
<li>A space's owners and members push to its projects. To let someone push to one project only, add them as a collaborator: ${code(cmd.collaborator)}</li>
<li>A login has no password: its token is the key. Save it when you register, or print it later with ${code(cmd.token)}</li>
</ul></section>

<section id="how"><h2>How to use it</h2>
<h3>In the browser</h3><ol>
${step('Register at the top right, and save the token you are shown.')}
${step('Click <b>New project</b>. Pick the space, then leave it empty or paste a GitHub URL to import that repository.')}
${step('Open a project to browse its files, commits and activity. Imported projects have <b>Sync from GitHub</b>.')}
</ol>
<h3>With the CLI</h3><ol>
${step('Install it (needs git and Node 22+):', cmd.install)}
${step('Log in as a builder:', cmd.login)}
${step('Share a repo (run inside it):', cmd.create)}
${step('Make a team space, add people, and share a repo into it:', cmd.team)}${code(cmd.teamMember)}${code(cmd.teamProject)}
${step("Mirror a GitHub user's or organization's public repositories into a space:", cmd.link)}
${step('Clone every project of a space into one folder, and keep them all current:', cmd.spaceClone)}${code(cmd.spaceSync)}
${step('Get a project:', cmd.clone)}
${step('Stay in sync (inside a clone):', cmd.sync)}
${step('Run a command on every push:', cmd.watch)}
${step('Edit together: commit, rebase and push every few seconds (inside a clone):', cmd.autosync)}
${step('See who is connected to a project:', cmd.who)}
</ol>
<h3>With plain git</h3><p>After installing the CLI, git understands the hub's addresses. The hub's remote is called <code>${esc(HUB.remote)}</code>, so <code>origin</code> stays free for GitHub.</p>
${code(cmd.gitClone)}${code(cmd.gitPush)}${code(cmd.gitPull)}
</section>

<section id="together"><h2>Edit together</h2>
<p>Several builders and agents can work in one project at the same time. Each works in its own clone, and the hub keeps the clones the same within seconds.</p>
<h3>Set it up</h3><ol>
${step('Put the project in a team space and add everyone as members:', cmd.teamMember)}
${step('Each one clones the project:', cmd.clone)}
${step('Each one starts autosync inside the clone and leaves it running:', cmd.autosync)}
${step('Edit files as usual. To see who else is working right now:', cmd.who)}
</ol>
<h3>How it works</h3><ul>
<li><b>Members.</b> A space's owners and members push to every project in it. Only owners change its settings and members, import, or delete. Members are listed on the space page and with ${code(cmd.members)} A member can leave with ${code(cmd.leave)}</li>
<li><b>Autosync.</b> Every few seconds, autosync commits your changes as one <code>autosync: &lt;files&gt;</code> commit and pushes it. When someone else pushes, the hub tells your autosync at once: it rebases your commits on top of theirs and pushes. Edits to different files never need a manual pull. To commit less often: ${code(cmd.interval)}</li>
<li><b>Conflicts.</b> If you and someone else change the same lines, your autosync stops and lists the files. The rebase is paused, with git's conflict markers in those files. Fix them, then run ${code(cmd.resolve)} or <code>git rebase --abort</code> to keep your commits as they were, and start autosync again. Everyone else keeps going.</li>
<li><b>A whole space at once.</b> ${code(cmd.spaceClone)} puts every project in one folder, and ${code(cmd.spaceSync)} runs autosync in all of them, cloning new projects as they appear. A conflict pauses only its project; the others carry on.</li>
<li><b>Here now.</b> Every running autosync, sync or watch tells the hub which project (or whole space) and branch it follows. The project page lists them under <b>Here now</b>, the home page shows everyone on the hub, and they disappear when the command stops.</li>
<li><b>Live pages.</b> The home page, space pages and project pages update by themselves: new commits, activity, members and who is here appear without a reload. The green <b>live</b> dot at the top right shows a page is following the hub.</li>
</ul>
<h3>Without autosync</h3><p>Members can also use plain git, pulling before they push:</p>${code(cmd.gitRebase)}
<p><code>project sync --watch</code> on its own only fast-forwards, for copies you read but do not edit.</p>
</section>

<section id="use-cases"><h2>Use cases</h2>
<div class="cases">
<div class="case"><h3>One repo on every machine</h3><p>Create the project once, clone it on each laptop, cloud machine or agent, and keep each copy current.</p>${code(cmd.clone)}${code(cmd.sync)}</div>
<div class="case"><h3>Hand work to an agent</h3><p>The agent waits for your push and starts on it right away. Its push comes back to you the same way.</p>${code(cmd.watch)}</div>
<div class="case"><h3>Edit together</h3><p>Add the others to a team space. Each runs autosync in a clone, and every edit reaches the others within seconds. The project page shows who is here now.</p>${code(cmd.teamMember)}${code(cmd.autosync)}</div>
<div class="case"><h3>Mirror a GitHub repo</h3><p>Click <b>New project</b> and paste the GitHub URL. Use <b>Sync from GitHub</b> on the project to pull later changes.</p></div>
<div class="case"><h3>Mirror a whole GitHub organization</h3><p>Link a space to it: every public repository becomes a project with the same name, kept in step. Work done here is never overwritten; a branch GitHub moved another way is kept and marked <b>diverged</b>.</p>${code(cmd.link)}</div>
<div class="case"><h3>Follow the work</h3><p>The <b>Activity</b> feed on the home page and on each project shows every push, import and change, newest first.</p></div>
</div></section>
</div>`;
}
