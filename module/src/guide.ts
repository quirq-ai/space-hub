// The hub's guide: what it is, who can use it, how to use it, use cases.
// One source for both the full page (/guide) and the short version at the
// top of the home page. Keep it plain and short; the README has the rest.
//
// HUB is the remote name and URL scheme git uses (quirq, quirq://<host>/<agent>/<space>).
// TODO: the sign-in wording still says anyone can register; on a hub that
// serves xo (SPACEHUB_XO_KEY), agents come from xo login instead.
import { esc } from './style';

const HUB = {
  cli: 'spacehub',
  remote: 'quirq',
  source: 'https://github.com/quirq-ai/space-hub',
  // The git URL of a space: it names the hub, so it works whichever hub the CLI is logged in to.
  url: (host: string, space: string) => `quirq://${host}/${space}`,
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
    login: `${c} auth login --server ${ctx.server} --agent <name>`,
    create: `${c} space create <name> --source . --push`,
    clone: `${c} space clone <agent>/<name>`,
    sync: `${c} space sync --watch`,
    watch: `${c} space watch <agent>/<name> --exec "<command>"`,
    member: `${c} space member add <name> <agent>`,
    autosync: `${c} space sync --watch --auto`,
    who: `${c} space who <agent>/<name>`,
    members: `${c} space member list <agent>/<name>`,
    leave: `${c} space member remove <agent>/<name> <your agent>`,
    interval: `${c} space sync --watch --auto --interval 10`,
    resolve: 'git add <files> && git rebase --continue',
    gitRebase: `git pull --rebase ${HUB.remote} main && git push ${HUB.remote} main`,
    token: `${c} auth token`,
    gitClone: `git clone -o ${HUB.remote} ${HUB.url(ctx.host, '<agent>/<name>')}`,
    gitPush: `git push ${HUB.remote} main`,
    gitPull: `git pull ${HUB.remote} main`,
  };
}

const LEAD =
  'spacehub keeps git repositories, called spaces, that people and AI agents share. Push with plain git, and every connected copy gets the change within seconds.';

// The short version for the home page.
export function guideHome(ctx: GuideContext): string {
  const cmd = commands(ctx);
  return `<div class="box guide-box"><div class="guide-head"><p class="guide-lead">${esc(LEAD)}</p><a class="btn" href="${esc(ctx.link('guide'))}">Read the guide</a></div>
<div class="guide">
<div><h3>Who can use it</h3><ul>
<li>Anyone can browse spaces and clone them.</li>
<li>To create spaces or push, you need an agent: an account for a person or an AI agent. Register at the top right, or with the CLI.</li></ul></div>
<div><h3>Get started</h3><ol>
<li>Install the CLI (needs git and Node 22+):${code(cmd.install)}</li>
<li>Log in as an agent:${code(cmd.login)}</li>
<li>Share a repo (run inside it):${code(cmd.create)}</li></ol></div>
<div><h3>Use cases</h3><ul>
<li>Keep one repo the same on your laptop, cloud machines and AI agents.</li>
<li>Hand work between people and agents in seconds.</li>
<li>Edit one space with other agents at the same time: see <a href="${esc(ctx.link('guide'))}#together">Edit together</a>.</li>
<li>Copy GitHub repos here and keep them updated.</li></ul></div>
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
<p>A hub for git repositories. You use plain git to push and pull. The hub tells every connected copy about each push as it happens, so machines, people and AI agents stay on the same code.</p>
<dl class="terms">
<dt>Space</dt><dd>A git repository on this hub, named <code>agent/name</code>.</dd>
<dt>Agent</dt><dd>An account, for a person or an AI agent. Agents create spaces and push to them.</dd>
<dt>Member</dt><dd>Another agent that a space's agent lets push to the space.</dd>
<dt>Builder</dt><dd>Who made a space's code: the GitHub owner for an imported repo, otherwise the agent.</dd>
<dt>Activity</dt><dd>The log of every change on the hub: pushes, new spaces, imports and edits.</dd>
</dl></section>

<section id="who"><h2>Who can use it</h2><ul>
<li><b>Anyone</b> who can open this page can browse every space, read the activity and clone any space.</li>
<li><b>Agents</b> can also create spaces, push and import from GitHub. Register an agent at the top right, or with ${code(cmd.login)}</li>
<li>A space's own agent can push to it, and so can the agents it adds as members: ${code(cmd.member)}</li>
<li>An agent has no password: its token is the key. Save it when you register, or print it later with ${code(cmd.token)}</li>
</ul></section>

<section id="how"><h2>How to use it</h2>
<h3>In the browser</h3><ol>
${step('Register at the top right, and save the token you are shown.')}
${step('Click <b>New space</b>. Leave it empty, or paste a GitHub URL to import that repository.')}
${step('Open a space to browse its files, commits and activity. Imported spaces have <b>Sync from GitHub</b>.')}
</ol>
<h3>With the CLI</h3><ol>
${step('Install it (needs git and Node 22+):', cmd.install)}
${step('Log in as an agent:', cmd.login)}
${step('Share a repo (run inside it):', cmd.create)}
${step('Get a repo:', cmd.clone)}
${step('Stay in sync (inside a clone):', cmd.sync)}
${step('Run a command on every push:', cmd.watch)}
${step('Edit together: commit, rebase and push every few seconds (inside a clone):', cmd.autosync)}
${step('See who is connected to a space:', cmd.who)}
</ol>
<h3>With plain git</h3><p>After installing the CLI, git understands the hub's addresses. The hub's remote is called <code>${esc(HUB.remote)}</code>, so <code>origin</code> stays free for GitHub.</p>
${code(cmd.gitClone)}${code(cmd.gitPush)}${code(cmd.gitPull)}
</section>

<section id="together"><h2>Edit together</h2>
<p>Several agents, people or AI, can work in one space at the same time. Each works in its own clone, and the hub keeps the clones the same within seconds.</p>
<h3>Set it up</h3><ol>
${step("The space's agent adds each other agent as a member:", cmd.member)}
${step('Each agent clones the space:', cmd.clone)}
${step('Each agent starts autosync inside its clone and leaves it running:', cmd.autosync)}
${step('Edit files as usual. To see who else is working right now:', cmd.who)}
</ol>
<h3>How it works</h3><ul>
<li><b>Members.</b> A space's agent can push to it, and so can its members. Only the agent changes the space's settings and members, imports, or deletes it. Members are listed on the space page and with ${code(cmd.members)} A member can leave with ${code(cmd.leave)}</li>
<li><b>Autosync.</b> Every few seconds, autosync commits your changes as one <code>autosync: &lt;files&gt;</code> commit and pushes it. When someone else pushes, the hub tells your autosync at once: it rebases your commits on top of theirs and pushes. Edits to different files never need a manual pull. To commit less often: ${code(cmd.interval)}</li>
<li><b>Conflicts.</b> If you and someone else change the same lines, your autosync stops and lists the files. The rebase is paused, with git's conflict markers in those files. Fix them, then run ${code(cmd.resolve)} or <code>git rebase --abort</code> to keep your commits as they were, and start autosync again. Everyone else keeps going.</li>
<li><b>Here now.</b> Every running autosync, sync or watch tells the hub which space and branch it follows. The space page lists them under <b>Here now</b>, the home page shows everyone on the hub, and they disappear when the command stops.</li>
<li><b>Live pages.</b> The home page, agent pages and space pages update by themselves: new commits, activity, members and who is here appear without a reload. The green <b>live</b> dot at the top right shows a page is following the hub.</li>
</ul>
<h3>Without autosync</h3><p>Members can also use plain git, pulling before they push:</p>${code(cmd.gitRebase)}
<p><code>space sync --watch</code> on its own only fast-forwards, for copies you read but do not edit.</p>
</section>

<section id="use-cases"><h2>Use cases</h2>
<div class="cases">
<div class="case"><h3>One repo on every machine</h3><p>Create the space once, clone it on each laptop, cloud machine or agent, and keep each copy current.</p>${code(cmd.clone)}${code(cmd.sync)}</div>
<div class="case"><h3>Hand work to an agent</h3><p>The agent waits for your push and starts on it right away. Its push comes back to you the same way.</p>${code(cmd.watch)}</div>
<div class="case"><h3>Edit together</h3><p>Add the other agents as members. Each runs autosync in its clone, and every edit reaches the others within seconds. The space page shows who is here now.</p>${code(cmd.member)}${code(cmd.autosync)}</div>
<div class="case"><h3>Mirror a GitHub repo</h3><p>Click <b>New space</b> and paste the GitHub URL. Use <b>Sync from GitHub</b> on the space to pull later changes.</p></div>
<div class="case"><h3>Follow the work</h3><p>The <b>Activity</b> feed on the home page and on each space shows every push, import and change, newest first.</p></div>
</div></section>
</div>`;
}
