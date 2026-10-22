# spacehub

Git hosting with a GitHub-style layout (`owner/space`), stored in SpacetimeDB.
Like GitHub, it has two halves:

- **Server**: a SpacetimeDB instance running the spacehub module, which holds
  owners, spaces, refs and git objects and enforces the push rules. It ships
  as a Docker image.
- **Client**: `spacehub`, a gh-style CLI, plus `git-remote-spacehub`, which
  makes plain git understand `spacehub://owner/space`.

Its main job is to keep the git trees of different spaces (machines,
sandboxes, agents) in sync.

```sh
spacehub auth login --server wss://hub.example.com --username suraj
spacehub space create notes --source . --push
spacehub space clone suraj/notes
git push spacehub / git pull spacehub main   # plain git from here on
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
- everything else: the web UI (see below).

Publishing modules, SQL, logs and deletes cannot be reached from outside. On
every start, the module is published or updated in place. A schema change
that would delete data makes startup fail rather than wipe spaces.

| Setting | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Public port |
| `SPACEHUB_DB` | `spacehub` | Database name clients pass with `--db` |
| `/data` volume | | Databases, the server's signing keys, and the identity that owns the module. **Mount persistent storage here and back it up.** Without it, a restart forgets all spaces and invalidates every client token |

The container starts as root only to take ownership of `/data`, because
platform volumes usually mount root-owned. It then runs everything as uid
1000. If your platform forces a non-root user, give the pod an `fsGroup` of
1000 so `/data` is writable.

Admin tasks run inside the container. For example, to follow the logs:
`docker exec spacehub spacetime --root-dir /data logs --server http://127.0.0.1:3001 spacehub -f`.

**With HTTPS (compose).** `SPACEHUB_DOMAIN=hub.example.com docker compose up -d --build`
adds a Caddy front that gets a certificate and forwards to the server.
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

The server's URL is also a small, read-only, GitHub-style site. The module
renders it straight from the tables, as plain HTML with no JavaScript.

| Path | Shows |
| --- | --- |
| `/` | All spaces, most recently pushed first, plus people and how to connect |
| `/<owner>` | An owner's spaces |
| `/<owner>/<space>` | Files at the default branch, README, clone commands, branch and tag counts |
| `/<owner>/<space>/tree/<ref>/<path>` | A folder at a branch, tag or commit |
| `/<owner>/<space>/blob/<ref>/<path>` | A file with line numbers |
| `/<owner>/<space>/raw/<ref>/<path>` | The file's bytes |
| `/<owner>/<space>/commits/<ref>` | History (latest 100) |
| `/<owner>/<space>/commit/<oid>` | One commit and the files it changed |
| `/<owner>/<space>/refs` | Branches and tags |

Raw files are served as `text/plain` or `application/octet-stream`, inside
a sandbox, so a pushed HTML file can't run on the server's origin. On a bare
`spacetime start`, open
`http://127.0.0.1:3000/v1/database/spacehub/route/ui`, where links use
`?p=<path>`.

## Install the client

Install it the same way you'd install gh:

```sh
scripts/install-cli.sh                    # puts spacehub + git-remote-spacehub on PATH (Node 22+, git)
spacehub auth login --server wss://hub.example.com --username <you>
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
| `gh auth login` | `spacehub auth login [--server url] [--username name] [--with-token]` |
| `gh auth status` / `token` / `logout` | `spacehub auth status` / `token` / `logout --yes` |
| `gh repo create name --source . --push` | `spacehub space create name --source . --push` |
| `gh repo list [owner]` | `spacehub space list [owner]` |
| `gh repo view [repo]` | `spacehub space view [space]` |
| `gh repo clone repo [dir]` | `spacehub space clone space [dir] [-- git flags]` |
| `gh repo edit` | `spacehub space edit [space] --description t --default-branch b` |
| `gh repo delete repo --yes` | `spacehub space delete space --yes` |
| `gh repo sync` | `spacehub space sync [--push] [--watch]` |
| | `spacehub space watch [space] [--exec cmd]` streams ref changes live |

**The git remote is always named `spacehub`**, never `origin`, so a repo
can push to GitHub (`origin`) and spacehub side by side without conflict.
`space create --source` adds a `spacehub` remote, and `space clone` names
the clone's remote `spacehub`. With plain git, use
`git clone -o spacehub spacehub://owner/name` or
`git remote add spacehub spacehub://owner/name`. `repo` is an alias for `space`. A space is `owner/name`, or just `name` for
your own spaces. Inside a clone, commands default to the repository's
spacehub remote.

Your identity is a token in `~/.spacehub/config.json`, kept per server. There
are no passwords: the token is the account. To use the same account on
another machine, run
`spacehub auth token | ssh other spacehub auth login --server <url> --with-token`.
`SPACEHUB_SERVER`, `SPACEHUB_DB`, `SPACEHUB_TOKEN` and `SPACEHUB_HOME`
override the saved settings.

## Local development

```sh
spacetime start                           # terminal 1
scripts/setup.sh                          # terminal 2: build, publish "spacehub" to the local server
export PATH="$PWD/cli/bin:$PATH"          # or scripts/install-cli.sh
spacehub auth login --username <you>      # defaults to ws://127.0.0.1:3000
scripts/e2e.sh                            # 70 checks against a throwaway in-memory server
SPACEHUB_E2E_SERVER=ws://127.0.0.1:3000 scripts/e2e.sh   # against a running server, e.g. the Docker one
```

After changing the module, regenerate the client bindings with
`cd cli && npm run generate`.

## Layout

```
module/src/index.ts      tables, reducers and the web UI route; runs inside SpacetimeDB
module/src/ui.ts         the web UI pages
module/src/store.ts      reads objects back out of the tables
module/src/sha1.ts       lets the database verify every object id
cli/src/cli.ts           spacehub (auth, space)
cli/src/remote.ts        git-remote-spacehub
cli/src/git.ts           git plumbing: rev-list, cat-file, packfile writer
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
| `user` | identity | username (owner name) |
| `space` | `owner/name` | owner, description, default branch, object counters, timestamps |
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

## Limits (v0)

- Every space can be read by anyone who can reach the server. Only the owner
  can push, and there are no collaborators yet. Share one identity across
  machines with `auth token` and `auth login --with-token`.
- Objects are stored whole and uncompressed, in SpacetimeDB's memory. That
  suits code, not big binaries. The object size cap is 100 MiB.
- Transfers carry whole objects, not deltas. There are no shallow clones.
  Only SHA-1 repositories are supported.
- An interrupted push can leave unreferenced objects behind. They are
  harmless, and the retry skips them.
