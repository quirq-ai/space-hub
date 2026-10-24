# spacehub

Git hosting stored in SpacetimeDB, laid out like GitHub:

| GitHub | spacehub |
| --- | --- |
| user | **builder**: a person's login, with a personal space of the same name |
| organization | **team space**: a collection of projects with owners and members |
| repository | **project**, at `/<space>/<project>` |
| org member | space member: pushes to every project in the space |
| repo collaborator | project collaborator: pushes to one project |
| (none) | **agent**: a space with an identity of its own, connected to the spaces it works in and launched anywhere |

Every top-level name (`/<name>`) is a **space**: a builder's personal space,
a team space, or an agent. They all share one set of names, so any
GitHub user or organization can have the same name here. **Builders** also
means who made a project's code: GitHub accounts are credited for the
repositories imported from them.

Like GitHub, spacehub has two halves:

- **Server**: a SpacetimeDB instance running the spacehub module, which holds
  builders, spaces, projects, refs and git objects and enforces the push
  rules. It ships as a Docker image.
- **Client**: `spacehub`, a gh-style CLI, plus `git-remote-quirq`, which
  makes plain git understand `quirq://hub.quirq.dev/<space>/<project>`.

Its main job is to keep the git trees of different machines, sandboxes,
people and agents in sync.

```sh
spacehub auth login --builder suraj    # wss://hub.quirq.dev; another with --server
spacehub project create notes --source . --push
spacehub project clone suraj/notes
git push quirq / git pull quirq main     # plain git from here on
spacehub project sync --watch            # follow every push live
spacehub project sync --watch --auto     # edit together: commit, rebase and push every few seconds
```

## Spaces and projects

```sh
spacehub space create acme -d "our team"         # a team space; you are its owner
spacehub space member add acme bob               # bob pushes to every acme project (--owner: manages it too)
spacehub project create acme/site --source . --push
spacehub project clone acme/site
spacehub space view acme                         # owners, members, projects
spacehub project member add suraj/notes carol    # carol may push to this one project
```

- **Owners** of a space manage it: members, edits, imports, builder credits,
  deleting projects and the space. A personal space's owner is its builder.
- **Members** push to every project of the space and create projects in it.
  A member can remove itself; a team keeps at least one owner.
- **Collaborators** push to one project.
- A team space is deleted only when it has no projects left.

Older forms keep working: `space` commands given `space/name`, a bare name
that is not a space (it means your own project), or run inside a clone act
on that project as before, and `space create <name> --source ...` still makes
a project.

## Agents

An agent is a space with an identity of its own. Its definition is the
project `<agent>/home`, in the xo-agent-template layout (`SOUL.md`,
`IDENTITY.md`, `AGENTS.md`, `MEMORY.md`, `USER.md`, `TOOLS.md`, `memory/`,
`skills/`). Its owners are the owners of the space that owns it.

```sh
spacehub agent create scout -d "reads the web"   # owned by your personal space (--in <team> for a team's)
spacehub agent connect scout acme                # it may push to acme's projects (you own both)
spacehub agent run scout                         # run it here: ./scout/scout/home, ./scout/acme/<project>, ...
spacehub agent token scout                       # its token, for its owners (XO Swarm launches with it)
spacehub agent list | view | disconnect | delete
```

`--template <git url>` seeds the home from a template repository (its
`workspace/` folder if it has one, as xo-agent-template does).

**`agent run`** puts the agent's own space and every space it is connected
to in one folder, each a space folder kept current by autosync, and pushes
as the agent: commits carry its name, and pushes are credited to it. It
follows spaces it is connected to or disconnected from while it runs. Each
followed space shows it as running (presence mode `agent`, with `--host`,
the machine's name by default), and so does the agent's page. It runs as the
agent when logged in with the agent's token (`SPACEHUB_TOKEN`), or as one of
its owners, who fetch the token from the hub.

**The token.** `agent create` makes a fresh identity for the agent and hands
its token to the hub, which keeps it in the private `agent_secret` table.
Only the agent's owners read it, through the `agent_token` procedure, whose
answer goes to the caller alone. Reducer arguments never reach other
clients. An agent identity cannot register as a builder, make team spaces or
agents, or be connected anywhere without its owners.

**What XO Swarm needs** to launch an agent in a Coworker workspace:

1. git, Node 22+ and the spacehub CLI in the workspace image
   (`scripts/install-cli.sh`, or the client image).
2. `SPACEHUB_SERVER` (for example `wss://hub.quirq.dev`) and the agent's token
   as `SPACEHUB_TOKEN`, kept as a Swarm secret. An owner gets it with
   `spacehub agent token <agent>`; xo.quirq.dev can call `agent_token` as
   the user's builder, whose token it already keeps.
3. Start `spacehub agent run <agent> /workspace --host <workspace name>`, and
   restart it if it exits. Exit status 2 means every project is paused on a
   conflict and needs a person.
4. Point the runtime (Claude Code, Codex, OpenClaw) at
   `/workspace/<agent>/home` for its instructions and memory, and at
   `/workspace/<space>/<project>` to work in.

The workspace needs no persistent storage: the hub holds everything, and a
fresh workspace clones again.

## A whole space at once

```sh
spacehub space clone acme            # every project of acme, side by side, in ./acme
cd acme
spacehub space sync                  # fast-forward every project; clone new ones
spacehub space sync --watch --auto   # autosync in every project, with one connection
```

The folder has a clone of each project plus `.spacehub/space.json`, listing
the hub, the space and its projects (like quirq's `DEPS`). `space sync
--watch --auto` runs autosync in every project and clones projects that
appear while it runs. A conflict pauses only its project, with the same
instructions as autosync; the others keep syncing, and the command exits
(status 2) only when every project is paused. Inside one project's clone,
`space sync` still syncs just that project. Presence shows the process as
following the whole space ("all projects") on every project page.

## Mirroring GitHub

A space can mirror a GitHub user or organization: every public repository
becomes a project with the same name, so `github.com/acme/site` is
`hub/acme/site`. GitHub to hub only; pushing back to GitHub comes later.

```sh
spacehub space link acme https://github.com/acme   # owners only; syncs now
spacehub space link acme --sync                    # sync again now
spacehub space link acme --remove                  # stop; the projects stay
spacehub space view acme                           # what it mirrors, how the last sync went
```

The space page has the same, as a **GitHub** box with **Link**, **Sync now**
and **Unlink** for owners. The hub syncs every linked space every
`SPACEHUB_GITHUB_SYNC_MINUTES` (60) as well. New repositories become new
projects, credited to the GitHub account.

**Work done here is never overwritten.** For each branch and tag the sync
compares GitHub's value now, the hub's, and GitHub's value at the last sync:

| Case | What happens |
| --- | --- |
| Nobody changed it here | It follows GitHub, force pushes and deletions included |
| Changed here, and GitHub built on that | Fast-forward |
| Changed here, GitHub unchanged | Kept as it is here |
| Changed here, GitHub went another way | Kept as it is here, marked **diverged** on the refs page, in `project view` and in the activity feed |
| Deleted here | Stays deleted until GitHub moves it |

Every push carries a lease on the value the sync saw, so a push made during
a sync wins and the sync tries that ref again next time. Imports and **Sync
from GitHub** on a single project follow the same rules.

## Editing together

Several builders and agents can work in one project at the same time.

1. **Give them access.** Put the project in a team space and add everyone
   as members, or add collaborators to one project.
2. **Run autosync in each clone.** `spacehub project sync --watch --auto
   [--interval <seconds>]` (default 3) keeps the clone and its branch on the
   hub the same. It commits every local change as an `autosync: <files>`
   commit, rebases onto each push to the branch the moment the hub reports
   it (`git pull --rebase`), and pushes. People editing different files never
   need to pull by hand.
3. **On a conflict autosync stops** with exit status 2. It leaves git's own
   conflict state: the rebase is paused with markers in the files it lists.
   Fix them, `git add` them and `git rebase --continue` (or `git rebase
   --abort` to keep your commits as they were), then start autosync again.
   It refuses to start while a rebase or merge is unfinished.
4. **See who is here.** `spacehub project who <project>` lists who is
   connected to a project now, with their mode (`watch`, `sync` or
   `autosync`) and branch; `spacehub space who <space>` covers a whole space.
   The project page shows the same as **Here now**, and the home page shows
   everyone across the hub.

Plain `project sync --watch` still only fast-forwards. Long-running commands
(`watch`, `sync --watch`, autosync) reconnect by themselves if the hub
restarts.

## Deploy the server

The server image is the Dockerfile's default target:

```sh
docker build -t spacehub-server .
docker run -d --name spacehub -p 3000:3000 -v spacehub-data:/data spacehub-server
```

Inside the container, SpacetimeDB listens only on `127.0.0.1:3001`. The one
public port (`$PORT`, default 3000) is a built-in Caddy allowlist. It serves:

- the two client endpoints: the identity-token exchange and the database
  websocket;
- `/healthz`, for health checks;
- `/-/guide` and `/-/builders`: the hub's own pages, rendered by the module;
- `/-/*`: the web service (sign in, register, create and import projects, live pages);
- everything else: the web UI (see below).

Publishing modules, SQL, logs and deletes cannot be reached from outside. On
every start, the module is published or updated in place, and
`migrate_spaces` gives builders from before spaces their personal spaces. A
schema change that would delete data makes startup fail rather than wipe
projects.

| Setting | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Public port |
| `SPACEHUB_DB` | `spacehub` | Database name clients pass with `--db` |
| `SPACEHUB_IMPORT_MAX_MB` | `500` | Largest GitHub repository the UI will import |
| `SPACEHUB_GITHUB_SYNC_MINUTES` | `60` | How often spaces linked to GitHub sync on their own (`0`: only when asked) |
| `SPACEHUB_GITHUB_MAX_REPOS` | `100` | Most repositories mirrored per linked space |
| `SPACEHUB_GITHUB_TOKEN` | unset | A GitHub token for a higher API rate limit (read-only public access is enough) |
| `SPACEHUB_XO_KEY` | unset | Turns on xo.quirq.dev's API and makes xo the only source of builders (see xo below) |
| `/data` volume | | Databases, the server's signing keys, and the identity that owns the module. **Mount persistent storage here and back it up.** Without it, a restart forgets every project and invalidates every client token |

The container starts as root only to take ownership of `/data`, because
platform volumes usually mount root-owned. It then runs everything as uid
1000. If your platform forces a non-root user, give the pod an `fsGroup` of
1000 so `/data` is writable.

Admin tasks run inside the container. For example, to follow the logs:
`docker exec spacehub spacetime --root-dir /data logs --server http://127.0.0.1:3001 spacehub -f`.

**With HTTPS (compose).** `SPACEHUB_DOMAIN=hub.example.com docker compose up -d --build`
adds a Caddy front that gets a certificate and forwards to the server. Add
`SPACEHUB_XO_KEY=...` to the same command to turn on xo's API (see xo below).
Clients then connect with `wss://hub.example.com`.

**On an XO deployment (registry.xo.builders).**

```sh
docker build --platform linux/amd64 -t registry.xo.builders/<project>/app:latest .
docker push registry.xo.builders/<project>/app:latest
```

Set three things in the deployment:

- application port **3000**;
- persistent storage mounted at **/data**;
- live URL on.

Clients then log in with `--server wss://<live url host>`.

**Maincloud.** You can skip Docker and run on SpacetimeDB's hosted cloud
instead: `scripts/setup.sh maincloud`. Pick a unique name with `SPACEHUB_DB`.

## Web UI

The server's URL is also a GitHub-style site. The module renders every page
straight from the tables, as plain HTML that works without JavaScript.

**Live pages.** The home page, space pages and every project page update by
themselves: new pushes, activity, members and who is here appear without a
reload, and a "live" dot shows in the header. The page loads `/-/live.js`
from the web service, which streams the page's new rendering over
Server-Sent Events (`/-/live?path=<page>`). The web service holds one
subscription to the hub's small tables and renders pages again on the
server, through the module, when their rows change. The browser never
connects to SpacetimeDB. Without JavaScript, pages stay as they were
rendered.

**Browse**

| Path | Shows |
| --- | --- |
| `/` | All projects, most recently pushed first; below them the hub's **Activity** feed (`?page=2` for older); plus who is here now, team spaces and builders |
| `/<space>` | A builder's personal space (its projects, and the spaces and projects it belongs to) or a team space (its projects, owners and members, who is here) |
| `/<space>/<project>` | Files at the default branch, each with its last commit; the README rendered as Markdown; clone commands, **Here now**, its space and collaborators, commit, branch and tag counts |
| `/<space>/<project>/tree/<ref>/<path>` | A folder at a branch, tag or commit, with a branch/tag picker |
| `/<space>/<project>/blob/<ref>/<path>` | A file. Code has linkable line numbers (`#L12`); Markdown is rendered (`?plain=1` shows the source); images are shown |
| `/<space>/<project>/raw/<ref>/<path>` | The file's bytes |
| `/<space>/<project>/commits/<ref>/<path>` | History, grouped by day and paged (`?page=2`). With a path, only the commits that changed it |
| `/<space>/<project>/commit/<oid>` | One commit: message, author, parents, and a line diff of every changed file |
| `/<space>/<project>/refs` | Branches and tags, with tag messages |
| `/<space>/<project>/activity` | That project's activity, paginated |
| `/-/guide` | What the hub is, who can use it, how to use it (browser, CLI, plain git), editing together (how members, autosync, conflicts, Here now and live pages work) and use cases; the home page shows a short version |
| `/-/builders`, `/-/builders/<login>` | Who built the projects' code (builders here and GitHub accounts), and everything a GitHub builder built |

The hub's own pages live under `/-/` so any GitHub name can be a space.
`/guide` and `/builders` redirect there unless a space has that name.

**Activity.** Every change on the hub is logged, newest first, 30 per
page. That covers:

- builders joining;
- projects created, edited and deleted;
- team spaces created, edited and deleted, and their members joining or
  leaving;
- builder credits;
- collaborators added, removed or leaving;
- each push, with the branch or tag, how many new commits, and the latest
  commit message;
- new branches and tags, force pushes and deletions;
- GitHub imports and syncs, with their outcome. An import is logged as one
  entry, not one per branch.

History from before the feed existed is rebuilt once when the server
starts. That covers builders, projects, builder credits, imports, and each
branch and tag's latest push. Deleted projects stay in the hub feed.

**Builders.** Every project has a space (where it lives here) and a builder
(who made the code):

- A GitHub import is credited to the repository's GitHub owner, with
  GitHub's display name. Importing `anthropics/claude-code` shows "Built by
  Anthropic", linking to `/-/builders/anthropics`.
- A project a builder pushed is credited to that builder: the personal
  space's builder, or whoever created it in a team space.
- An owner can credit a GitHub account by hand, for example for a repo
  pushed from a local clone instead of imported:
  `spacehub project edit <project> --builder anthropics` (or a github.com URL),
  or the New project form's **Built by** field, which checks the account exists
  on GitHub. Builders must be GitHub users or organizations.
  `--builder ""` goes back to the default.

The home page lists **Builders**, each marked GitHub or builder. Projects
imported before builders existed show the GitHub
handle until their next **Sync from GitHub**, which fills in the display
name.

**Add from the browser**

- **Register** (`/-/signup`) registers a builder: pick the name, and the
  server creates its identity. The token is shown once. It is the login, and
  the CLI can use it too (`spacehub auth login --with-token`).
- **Sign in** (`/-/login`) takes an existing token, for example from
  `spacehub auth token`.
- **New project** (`/-/new`) creates an empty project in your personal space
  or a space you belong to, or imports a public GitHub repository. Paste
  `https://github.com/owner/repo`, and the server clones it with all
  branches, tags and history into `<space>/<repo>`, using GitHub's
  description and default branch. The project page shows the import's
  progress.
- **Sync from GitHub**, on an imported project, pulls GitHub's latest branches
  and tags again. Moved or deleted branches follow GitHub.

The web service runs inside the server container and acts as the signed-in
builder, so the database's ownership rules apply to every action. The session
is the builder's token in an `HttpOnly` cookie. Forms only work from the site itself.
Only `github.com` URLs are accepted, which keeps the server from being
pointed at internal addresses. Private repositories can't be imported yet.

Raw files are served as `text/plain`, an image type, or
`application/octet-stream`, inside a sandbox, so a pushed HTML file can't
run on the server's origin. On a bare `spacetime start` (no web service),
browse at `http://127.0.0.1:3000/v1/database/spacehub/route/ui`, where links
use `?p=<path>`.

## Install the client

Install it the same way you'd install gh:

```sh
scripts/install-cli.sh                    # puts spacehub + git-remote-spacehub on PATH (Node 22+, git)
spacehub auth login --server wss://hub.example.com --builder <name>
```

Or use the client image, which bundles git, the CLI and the helper. It's
handy for sandboxes and CI:

```sh
docker build --target client -t spacehub .
docker run --rm -it -e SPACEHUB_SERVER=wss://hub.example.com \
  -v spacehub-home:/home/node/.spacehub spacehub auth status
```

### gh to spacehub

| gh | spacehub |
| --- | --- |
| `gh auth login` | `spacehub auth login [--server url] [--builder name] [--with-token]` (`--agent`, `--username` are aliases) |
| `gh auth status` / `token` / `logout` | `spacehub auth status` / `token` / `logout --yes` |
| `gh repo create name --source . --push` | `spacehub project create [space/]name --source . --push` |
| `gh repo list [owner]` | `spacehub project list [space]` |
| `gh repo view [repo]` | `spacehub project view [project]` |
| `gh repo clone repo [dir]` | `spacehub project clone project [dir] [-- git flags]` |
| `gh repo edit` | `spacehub project edit [project] --description t --default-branch b` |
| `gh repo delete repo --yes` | `spacehub project delete project --yes` |
| `gh repo sync` | `spacehub project sync [--push] [--watch]`; `--auto` for autosync (see Editing together) |
| collaborators (`gh api`) | `spacehub project member add\|remove [project] builder`, `member list [project]` |
| `gh org` and its members (web) | `spacehub space create\|list\|view\|edit\|delete`, `space member add\|remove\|list <space> [name] [--owner]` |
| | `spacehub project watch [project] [--exec cmd]` streams ref changes live |
| | `spacehub project who [project]`, `spacehub space who <space>` list who is connected now |
| | `spacehub space clone <space> [dir]`, `spacehub space sync [--watch] [--auto]` work on a whole space at once |
| | `spacehub agent create\|list\|view\|connect\|disconnect\|token\|run\|delete` for agents |

`repo` is an alias for `project`.

**The git remote is always named `quirq` and always points at a quirq URL**,
`quirq://<hub host>/<space>/<project>`, never at `origin`, so a repo can push
to GitHub (`origin`) and the hub side by side without conflict. `project
create --source` adds a `quirq` remote (and `--push` pushes without setting
an upstream, so your branches keep tracking what they tracked), and `project
clone` names the clone's remote `quirq`. With plain git, use
`git clone -o quirq quirq://hub.quirq.dev/<space>/<project>` or
`git remote add quirq quirq://hub.quirq.dev/<space>/<project>`. The URL names
the hub, so the remote keeps working whatever server the CLI is logged in to;
`quirq://<space>/<project>` means the hub you are logged in to. Remotes of
older clones (`spacehub://space/project`, often named `spacehub`) keep working
through `git-remote-spacehub`. A project is `space/name`, or just `name` for
your personal space. Inside a clone, commands default to the repository's
quirq remote.

A login is a token in `~/.spacehub/config.json`, kept per server. There are
no passwords: the token is the builder. To be the same builder on another
machine, run
`spacehub auth token | ssh other spacehub auth login --server <url> --with-token`.
`SPACEHUB_SERVER`, `SPACEHUB_DB`, `SPACEHUB_TOKEN` and `SPACEHUB_HOME`
override the saved settings.

## Local development

```sh
spacetime start                           # terminal 1
scripts/setup.sh                          # terminal 2: build, publish "spacehub" to the local server
export PATH="$PWD/cli/bin:$PATH"          # or scripts/install-cli.sh
spacehub auth login --server ws://127.0.0.1:3000 --builder <name>
scripts/e2e.sh                            # 281 checks against a throwaway in-memory server and a stand-in GitHub
SPACEHUB_E2E_GITHUB=1 scripts/e2e.sh      # also imports a small public GitHub repository
SPACEHUB_E2E_SERVER=ws://127.0.0.1:3000 scripts/e2e.sh   # against a running server, e.g. the Docker one
```

After changing the module, regenerate the client bindings with
`cd cli && npm run generate`. Unit tests need no server: `cd module && npm
test` runs the reducers in SpacetimeDB's in-process harness, and `cd cli &&
npm test` runs the xo API against a stand-in database, and autosync and the
GitHub sync's rules against plain git repositories.

## Layout

```
module/src/index.ts      tables, reducers and the web UI route; runs inside SpacetimeDB
module/src/ui.ts         the web UI pages
module/src/markdown.ts   safe Markdown for READMEs and .md files
module/src/diff.ts       line diffs for commit pages
module/src/style.ts      look and page frame, shared with the web service
module/src/guide.ts      the guide's wording, for /-/guide and the home page
module/src/store.ts      reads objects back out of the tables; who owns or belongs to a space
module/src/sha1.ts       lets the database verify every object id
cli/src/cli.ts           spacehub (auth, space, project)
cli/src/remote.ts        git-remote-quirq (and git-remote-spacehub, for older clones)
cli/src/url.ts           quirq:// URLs
cli/src/xo.ts            xo.quirq.dev's API: xo's per-user records and builders
cli/src/git.ts           git plumbing: rev-list, cat-file, packfile writer
cli/src/web.ts           web service: sign in/up, create and import projects
cli/src/live.ts          live pages: the /-/live event stream (livepage.ts: the page script)
cli/src/github.ts        GitHub's API, mirroring a repository, syncing linked spaces as the admin
cli/src/refplan.ts       the sync's rules: what moves, what is kept, what diverged
cli/src/autosync.ts      autosync: commit, rebase, push; stop on a conflict; the step loop
cli/src/spacesync.ts     a whole space in one folder: space clone and space sync
cli/src/agentrun.ts      spacehub agent run: an agent's home and connected spaces, autosynced
cli/src/agenttemplate.ts the starter definition of an agent's home project
cli/src/module_bindings  generated, do not edit
Dockerfile               targets: server (default), client
docker-compose.yml       server + Caddy TLS front
docker/                  server entrypoint, built-in allowlist (server.Caddyfile), compose Caddyfile
scripts/                 setup.sh, install-cli.sh, e2e.sh
```

## How it works

**Data model**

Stored names predate team spaces: the `space` table holds projects and
`space_id` columns hold a project's id, because SpacetimeDB cannot rename
tables or columns in place. In the code they are called projects.

| Table | Key | Holds |
| --- | --- | --- |
| `user` | identity | a builder's name |
| `hub_space` | name | a top-level space: `personal` (a builder's), `team` or `agent` (with its parent space); display name, description, creator |
| `space_role` | space + member | a space's owners and members |
| `space` | `space/project` | a project: its space (`owner`), description, default branch, object counters, timestamps |
| `space_import` | project | GitHub source, import status |
| `space_builder` | project | the credited GitHub builder: login, display name, profile |
| `activity` | id (time, project indexed) | one row per change: who, what, which space or project and ref, commit, count, text |
| `git_ref` | project + ref name | `refs/heads/*` and `refs/tags/*`, mapped to object ids |
| `git_object` | project + oid | kind, size, raw body (inline up to 1 MiB) and `pos`, its place in the project's object log |
| `object_chunk` | project + oid + index | 1 MiB pieces of larger objects |
| `space_member` | project + builder | a project's collaborators |
| `agent` | name | an agent's identity and creator (its space is in `hub_space`, kind `agent`) |
| `agent_secret` | name | (private) an agent's token, read only through `agent_token` by its owners |
| `space_link` | space | the GitHub account it mirrors, the last sync's status and time |
| `ref_sync` | project + ref | GitHub's value at the last sync, and whether the hub's copy follows it or diverged |
| `presence` | connection | which project (or whole space) a connected client follows, its mode and branch (or an agent's host), and its last heartbeat |

**Push.** The helper lists the objects the project lacks
(`git rev-list --objects <new> --not <remote refs>`). It uploads them in
batches of about 4 MiB, and chunks objects over 1 MiB. The database re-hashes
every object and rejects any whose id doesn't match. Then each ref moves
through `updateRef`, which checks four things:

- The caller owns or belongs to the project's space, or collaborates on the
  project.
- The ref still holds the value the pusher listed (compare-and-swap).
- Unless the push is forced, a branch move is a fast-forward. The database
  walks commit parents itself to check this.
- An existing tag doesn't move unless the push is forced.

`--force-with-lease` is honoured.

**Fetch.** The helper subscribes to the project's objects in windows of about
8 MiB, ordered by `pos`, and writes the missing ones into the repo as a
packfile. `.git/spacehub/` records how far it has read, so later fetches only
download newer objects. If that record is out of date, the helper re-reads
the whole project.

**Sync.** Refs are rows, so `project watch` and `project sync --watch` hear about
a push as soon as it commits. No polling is involved.

**Presence.** A long-running command calls `watch_space` with its project,
mode and branch, and repeats it every minute as a heartbeat. The row is keyed
by the connection, so SpacetimeDB's `client_disconnected` removes it when the
command stops. If a connection vanishes without closing, its row is swept by
the next `client_connected` once its heartbeat is three minutes old, and
pages and `project who` hide it as soon as it is stale.

**Compatibility.** Reducers that act on one repository keep their names
from before team spaces (`create_space`, `edit_space`, `delete_space`,
`add_member`, ...), with the project's full name as their `space` argument,
so older CLIs keep pushing, cloning and syncing after an upgrade.

## xo

xo.quirq.dev checks who an xo user is with Clerk and keeps everything else
here: each user's projects, spaces with their refs, and invites, as one JSON
record per Clerk user in the private `xo_record` table. It also asks the hub
for the user's builder (named after their xo username, in the private
`xo_agent` table), whose token the user's xo then pushes with. Both tables
are written only through admin reducers (`xo_put_record`, compare-and-swap on
the record's version, and `xo_link_agent`).

- **The admin** is the identity that owns the database. The entrypoint calls
  `claim_admin` right after every publish; the first claim sticks, and if
  another identity ever holds it the server refuses to start.
- **GitHub sync** runs as the admin too: the entrypoint always hands the
  admin's token to the web service, whose sync may create projects and push
  only in spaces linked to GitHub (shown as "GitHub sync" in the activity).
  git sees that token only when it pushes into the hub.
- **Turn it on** by setting `SPACEHUB_XO_KEY` (32 characters or more, the same
  value as xo.quirq.dev's `XO_HUB_KEY`). The web service then answers
  `/-/api/xo/v1/` (see `cli/src/xo.ts`) with that key only, acting as the
  admin over SpacetimeDB's HTTP API inside the container, and builders come
  from xo only: open sign-up (`register_user`) is refused.
- **Names.** xo's record was designed when a hub space was one repository,
  so its "spaces" are hub projects today, and an xo project (a group of
  repositories) is closest to a hub space. The hub stores the record as
  opaque JSON, so nothing breaks; xo's own code should rename to match.

## Limits (v0)

- Mirroring is GitHub to hub, public repositories only.
- Every project can be read by anyone who can reach the server. Only its
  space's owners and members and its collaborators can push; they can do
  anything a push does, including force pushes and deleting branches. To be
  one builder on several machines, use `auth token` and `auth login
  --with-token`.
- Autosync commits often and with generated messages; squash before sharing
  the history elsewhere if that matters. It skips commit hooks.
- Anyone who can reach the server can register a builder (with `SPACEHUB_XO_KEY` set, only xo makes them), create team spaces and import public GitHub
  repositories (up to `SPACEHUB_IMPORT_MAX_MB` each). Keep that in mind
  before exposing a server publicly.
- Objects are stored whole and uncompressed, in SpacetimeDB's memory. That
  suits code, not big binaries. The object size cap is 100 MiB.
- Transfers carry whole objects, not deltas. There are no shallow clones.
  Only SHA-1 repositories are supported.
- An interrupted push can leave unreferenced objects behind. They are
  harmless, and the retry skips them.
