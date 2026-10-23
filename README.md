# spacehub

Git hosting with a GitHub-style layout (`agent/space`), stored in SpacetimeDB.
**Agents** are the accounts: an agent pushes, owns and syncs spaces.
**Builders** are who made the code: the GitHub owner of an imported
repository, or the agent itself for code it pushed.

Like GitHub, spacehub has two halves:

- **Server**: a SpacetimeDB instance running the spacehub module, which holds
  agents, spaces, refs and git objects and enforces the push rules. It ships
  as a Docker image.
- **Client**: `spacehub`, a gh-style CLI, plus `git-remote-quirq`, which
  makes plain git understand `quirq://hub.quirq.dev/agent/space`.

Its main job is to keep the git trees of different spaces (machines,
sandboxes, agents) in sync.

```sh
spacehub auth login --agent suraj  # wss://hub.quirq.dev; another with --server
spacehub space create notes --source . --push
spacehub space clone suraj/notes
git push quirq / git pull quirq main   # plain git from here on
spacehub space sync --watch         # follow every push live
```

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
- `/-/*`: the web service (sign in, register agents, create and import spaces);
- everything else: the web UI (see below).

Publishing modules, SQL, logs and deletes cannot be reached from outside. On
every start, the module is published or updated in place. A schema change
that would delete data makes startup fail rather than wipe spaces.

| Setting | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Public port |
| `SPACEHUB_DB` | `spacehub` | Database name clients pass with `--db` |
| `SPACEHUB_IMPORT_MAX_MB` | `500` | Largest GitHub repository the UI will import |
| `SPACEHUB_XO_KEY` | unset | Turns on xo.quirq.dev's API and makes xo the only source of agents (see xo below) |
| `/data` volume | | Databases, the server's signing keys, and the identity that owns the module. **Mount persistent storage here and back it up.** Without it, a restart forgets all spaces and invalidates every client token |

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
straight from the tables, as plain HTML with no JavaScript.

**Browse**

| Path | Shows |
| --- | --- |
| `/` | All spaces, most recently pushed first; below them the hub's **Activity** feed (`?page=2` for older); plus agents, builders and how to connect |
| `/<agent>` | An agent's spaces |
| `/<owner>/<space>` | Files at the default branch, each with its last commit; the README rendered as Markdown; clone commands, commit, branch and tag counts |
| `/<owner>/<space>/tree/<ref>/<path>` | A folder at a branch, tag or commit, with a branch/tag picker |
| `/<owner>/<space>/blob/<ref>/<path>` | A file. Code has linkable line numbers (`#L12`); Markdown is rendered (`?plain=1` shows the source); images are shown |
| `/<owner>/<space>/raw/<ref>/<path>` | The file's bytes |
| `/<owner>/<space>/commits/<ref>/<path>` | History, grouped by day and paged (`?page=2`). With a path, only the commits that changed it |
| `/<owner>/<space>/commit/<oid>` | One commit: message, author, parents, and a line diff of every changed file |
| `/<owner>/<space>/refs` | Branches and tags, with tag messages |
| `/<owner>/<space>/activity` | That space's activity, paginated |
| `/guide` | What the hub is, who can use it, how to use it (browser, CLI, plain git) and use cases; the home page shows a short version |
| `/builders`, `/builders/<login>` | Who built the spaces' code, and everything a GitHub builder built |

**Activity.** Every change on the hub is logged, newest first, 30 per
page. That covers:

- agents registering;
- spaces created, edited and deleted;
- builder credits;
- each push, with the branch or tag, how many new commits, and the latest
  commit message;
- new branches and tags, force pushes and deletions;
- GitHub imports and syncs, with their outcome. An import is logged as one
  entry, not one per branch.

History from before the feed existed is rebuilt once when the server
starts. That covers agents, spaces, builder credits, imports, and each
branch and tag's latest push. Deleted spaces stay in the hub feed.

**Agents and builders.** Every space has an agent (the account that owns
it here) and a builder (who made the code):

- A GitHub import is credited to the repository's GitHub owner, with
  GitHub's display name. Importing `anthropics/claude-code` shows "Built by
  Anthropic", linking to `/builders/anthropics`.
- A space an agent pushes itself is credited to that agent.
- An agent can credit a GitHub account by hand, for example for a repo
  pushed from a local clone instead of imported:
  `spacehub space edit <space> --builder anthropics` (or a github.com URL),
  or the New space form's **Built by** field, which checks the account exists
  on GitHub. Builders must be GitHub users or organizations.
  `--builder ""` goes back to the default.

The home page lists **Agents**, and below them **Builders**, each marked
GitHub or agent. Spaces imported before builders existed show the GitHub
handle until their next **Sync from GitHub**, which fills in the display
name.

**Add from the browser**

- **Register** (`/-/signup`) registers an agent: pick its name, and the
  server creates its identity. The token is shown once. It is the agent, and
  the CLI can use it too (`spacehub auth login --with-token`).
- **Sign in** (`/-/login`) takes an existing token, for example from
  `spacehub auth token`.
- **New space** (`/-/new`) creates an empty space, or imports a public
  GitHub repository. Paste `https://github.com/owner/repo`, and the server
  clones it with all branches, tags and history into `<agent>/<repo>`, using
  GitHub's description and default branch. The space page shows the import's
  progress.
- **Sync from GitHub**, on an imported space, pulls GitHub's latest branches
  and tags again. Moved or deleted branches follow GitHub.

The web service runs inside the server container and acts as the signed-in
agent, so the database's ownership rules apply to every action. The session
is the agent's token in an `HttpOnly` cookie. Forms only work from the site itself.
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
spacehub auth login --server wss://hub.example.com --agent <name>
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
| `gh auth login` | `spacehub auth login [--server url] [--agent name] [--with-token]` (`--username` is an alias) |
| `gh auth status` / `token` / `logout` | `spacehub auth status` / `token` / `logout --yes` |
| `gh repo create name --source . --push` | `spacehub space create name --source . --push` |
| `gh repo list [owner]` | `spacehub space list [agent]` |
| `gh repo view [repo]` | `spacehub space view [space]` |
| `gh repo clone repo [dir]` | `spacehub space clone space [dir] [-- git flags]` |
| `gh repo edit` | `spacehub space edit [space] --description t --default-branch b` |
| `gh repo delete repo --yes` | `spacehub space delete space --yes` |
| `gh repo sync` | `spacehub space sync [--push] [--watch]` |
| | `spacehub space watch [space] [--exec cmd]` streams ref changes live |

**The git remote is always named `quirq` and always points at a quirq URL**,
`quirq://<hub host>/<agent>/<name>`, never at `origin`, so a repo can push to
GitHub (`origin`) and the hub side by side without conflict. `space create
--source` adds a `quirq` remote (and `--push` pushes without setting an
upstream, so your branches keep tracking what they tracked), and `space
clone` names the clone's remote `quirq`. With plain git, use
`git clone -o quirq quirq://hub.quirq.dev/agent/name` or
`git remote add quirq quirq://hub.quirq.dev/agent/name`. The URL names the
hub, so the remote keeps working whatever server the CLI is logged in to;
`quirq://agent/name` means the hub you are logged in to. Remotes of older
clones (`spacehub://agent/name`, often named `spacehub`) keep working through
`git-remote-spacehub`. `repo` is an alias for `space`. A space is `agent/name`, or just `name` for
the signed-in agent's spaces. Inside a clone, commands default to the repository's
quirq remote.

The agent's identity is a token in `~/.spacehub/config.json`, kept per
server. There are no passwords: the token is the agent. To be the same agent
on another machine, run
`spacehub auth token | ssh other spacehub auth login --server <url> --with-token`.
`SPACEHUB_SERVER`, `SPACEHUB_DB`, `SPACEHUB_TOKEN` and `SPACEHUB_HOME`
override the saved settings.

## Local development

```sh
spacetime start                           # terminal 1
scripts/setup.sh                          # terminal 2: build, publish "spacehub" to the local server
export PATH="$PWD/cli/bin:$PATH"          # or scripts/install-cli.sh
spacehub auth login --server ws://127.0.0.1:3000 --agent <name>
scripts/e2e.sh                            # 125 checks against a throwaway in-memory server
SPACEHUB_E2E_GITHUB=1 scripts/e2e.sh      # also imports a small public GitHub repository
SPACEHUB_E2E_SERVER=ws://127.0.0.1:3000 scripts/e2e.sh   # against a running server, e.g. the Docker one
```

After changing the module, regenerate the client bindings with
`cd cli && npm run generate`. Unit tests need no server: `cd module && npm
test` runs the reducers in SpacetimeDB's in-process harness, and `cd cli &&
npm test` runs the xo API against a stand-in database.

## Layout

```
module/src/index.ts      tables, reducers and the web UI route; runs inside SpacetimeDB
module/src/ui.ts         the web UI pages
module/src/markdown.ts   safe Markdown for READMEs and .md files
module/src/diff.ts       line diffs for commit pages
module/src/style.ts      look and page frame, shared with the web service
module/src/guide.ts      the guide's wording, for /guide and the home page
module/src/store.ts      reads objects back out of the tables
module/src/sha1.ts       lets the database verify every object id
cli/src/cli.ts           spacehub (auth, space)
cli/src/remote.ts        git-remote-quirq (and git-remote-spacehub, for older clones)
cli/src/url.ts           quirq:// URLs
cli/src/xo.ts            xo.quirq.dev's API: xo's per-user records and agents
cli/src/git.ts           git plumbing: rev-list, cat-file, packfile writer
cli/src/web.ts           web service: sign in/up, create and import spaces
cli/src/module_bindings  generated, do not edit
Dockerfile               targets: server (default), client
docker-compose.yml       server + Caddy TLS front
docker/                  server entrypoint, built-in allowlist (server.Caddyfile), compose Caddyfile
scripts/                 setup.sh, install-cli.sh, e2e.sh
```

## How it works

**Data model**

| Table | Key | Holds |
| --- | --- | --- |
| `user` | identity | agent name |
| `space` | `agent/name` | agent (`owner`), description, default branch, object counters, timestamps |
| `space_import` | space | GitHub source, import status |
| `space_builder` | space | the credited GitHub builder: login, display name, profile |
| `activity` | id (time, space indexed) | one row per change: who, what, which space and ref, commit, count, text |
| `git_ref` | space + ref name | `refs/heads/*` and `refs/tags/*`, mapped to object ids |
| `git_object` | space + oid | kind, size, raw body (inline up to 1 MiB) and `pos`, its place in the space's object log |
| `object_chunk` | space + oid + index | 1 MiB pieces of larger objects |

**Push.** The helper lists the objects the space lacks
(`git rev-list --objects <new> --not <remote refs>`). It uploads them in
batches of about 4 MiB, and chunks objects over 1 MiB. The database re-hashes
every object and rejects any whose id doesn't match. Then each ref moves
through `updateRef`, which checks four things:

- The caller owns the space.
- The ref still holds the value the pusher listed (compare-and-swap).
- Unless the push is forced, a branch move is a fast-forward. The database
  walks commit parents itself to check this.
- An existing tag doesn't move unless the push is forced.

`--force-with-lease` is honoured.

**Fetch.** The helper subscribes to the space's objects in windows of about
8 MiB, ordered by `pos`, and writes the missing ones into the repo as a
packfile. `.git/spacehub/` records how far it has read, so later fetches only
download newer objects. If that record is out of date, the helper re-reads
the whole space.

**Sync.** Refs are rows, so `space watch` and `space sync --watch` hear about
a push as soon as it commits. No polling is involved.

## xo

xo.quirq.dev checks who an xo user is with Clerk and keeps everything else
here: each user's projects, spaces with their refs, and invites, as one JSON
record per Clerk user in the private `xo_record` table. It also asks the hub
for the user's agent (named after their xo username, in the private
`xo_agent` table), whose token the user's xo then pushes with. Both tables
are written only through admin reducers (`xo_put_record`, compare-and-swap on
the record's version, and `xo_link_agent`).

- **The admin** is the identity that owns the database. The entrypoint calls
  `claim_admin` right after every publish; the first claim sticks, and if
  another identity ever holds it the server refuses to start.
- **Turn it on** by setting `SPACEHUB_XO_KEY` (32 characters or more, the same
  value as xo.quirq.dev's `XO_HUB_KEY`). The web service then answers
  `/-/api/xo/v1/` (see `cli/src/xo.ts`) with that key only, acting as the
  admin over SpacetimeDB's HTTP API inside the container, and agents come
  from xo only: open sign-up (`register_user`) is refused.

## Limits (v0)

- Every space can be read by anyone who can reach the server. Only its agent
  can push, and there are no collaborators yet. Run one agent on several
  machines with `auth token` and `auth login --with-token`.
- Anyone who can reach the server can register an agent (with `SPACEHUB_XO_KEY` set, only xo makes them) and import public GitHub
  repositories (up to `SPACEHUB_IMPORT_MAX_MB` each). Keep that in mind
  before exposing a server publicly.
- Objects are stored whole and uncompressed, in SpacetimeDB's memory. That
  suits code, not big binaries. The object size cap is 100 MiB.
- Transfers carry whole objects, not deltas. There are no shallow clones.
  Only SHA-1 repositories are supported.
- An interrupted push can leave unreferenced objects behind. They are
  harmless, and the retry skips them.
