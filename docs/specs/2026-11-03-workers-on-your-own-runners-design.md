# Workers on your own runners: design

Date: 2026-11-03. Status: draft, decisions of 2026-11-03 applied (§15). Branch: `feat/per-user-agents-hub`
(space-hub). The first runner is the Agents Hub (xo-agents `hub-user/`, PRs #1 and #2), with the small
changes in §11.1.

## 1. Intent

Today every worker launched from a chat runs on **one** Agents Hub that the operator set
(`SPACEHUB_AGENTHUB_URL` + `SPACEHUB_AGENTHUB_TOKEN`), which runs on OpenAI's Agents API: one person's bill,
one person's sandboxes, one person's GitHub account opening every pull request.

After this change:
- **A worker runs on a runner of the person who launches it**: their account, their bill, their GitHub.
- **space-hub is agent-agnostic.** It talks to runners through one small HTTP API, the **Worker Protocol**
  (§5). The Agents Hub (OpenAI Agents API) is the first runner; an xo-space / xo-coworker workspace (Claude
  Code, Codex, OpenClaw), the claude-code container, or anything else can become one by speaking the
  protocol, with no change to space-hub.
- Each person connects one or more runners once and picks one when launching. Everyone in the space still
  sees and follows the worker in the channel.

space-hub is going to become a Launchpad template, so nothing here may assume one deployment: the operator
deploys space-hub; members bring their own runners.

## 2. Goals, non-goals, anti-goals

**Goals**
- A Worker Protocol that any agent system can implement: start, read, steps, follow up, stop, tear down,
  and describe itself (name, kind, capabilities).
- A person connects runners (address + token), names them, picks a default, tests and disconnects them.
- Launch runs on the runner the launcher picks (their default first). space-hub records which runner each
  worker is on and reads it from there for every member of the space.
- The card shows only what the runner supports (§5.4).
- When a worker finishes a turn, space-hub keeps a copy of its result, so the card still shows it after the
  worker is torn down or the runner is disconnected.
- Runner tokens are stored only on the server, encrypted, never sent to a browser or written to a log.
- A token given to space-hub sees only the tasks space-hub started (a protocol rule, §5.2).
- Shipped in this round: the protocol, the multi-runner data model and UI, and **one** runner (the Agents
  Hub). Other runners follow on the same protocol.

**Non-goals (decided by the user)**
- **No operator-wide shared hub.** `SPACEHUB_AGENTHUB_URL` / `_TOKEN` / `_SPACES` and the "signed in with xo"
  rule are removed. A person without a runner cannot launch (they still see and follow others' workers).
- Limiting which spaces allow workers (every space a person can write to allows it).
- Runners other than the Agents Hub in this round (sketched in §11.2–11.3 so the protocol fits them).
- **Sponsored runners** (a space owner sharing a runner with the space): designed for, built later (§12).
- space-hub calling any agent vendor's API itself: vendors live behind runners.
- Billing, quotas or spending limits (each runner's own account sets those).

**Anti-goals (a failure even if it works)**
- A runner token in a browser, a URL, a log line, an error message, a chat file or the activity feed.
- A person's runner used by anyone else for anything that spends or ends (follow up, stop, tear down).
- space-hub code that knows a vendor (OpenAI, Anthropic, …): if adding a runner kind needs space-hub code
  beyond a label, the protocol is wrong.
- A viewer reaching a runner's sandbox: everything goes through the runner's API, which only space-hub's
  server calls.

## 3. Words

- **Runner**: a service that runs workers and speaks the Worker Protocol (an Agents Hub app, a Coworker
  workspace's bridge, …). It belongs to one person; it runs on their account.
- **Runner kind**: what the runner says it is (`kind`, §5.3), shown as a label, e.g. "Agents Hub · OpenAI".
  space-hub never branches on it.
- **Worker**: one task on one runner, started from a chat. Shown as a worker card under its launch message.
- **Operator**: deploys space-hub; sets the encryption key (§7).
- **Launcher**: the person who launched a worker; it runs on their runner.
- **Viewer**: a signed-in member, owner or collaborator of the worker's space.

## 4. Workers and sessions (the Agents Hub runner)

Each runner decides what a worker is underneath; the protocol only fixes the outside (§5). For the Agents Hub:
one worker = one task = one OpenAI session = one sandbox (an executor app in the launcher's Launchpad account).

| Event | Effect |
|---|---|
| **Launch** (rocket in a channel) | Always a **new** worker: new task, new session, new sandbox. A channel can hold many workers. A plain Send never starts one. |
| **Follow up** | The **same** worker: same session (the agent keeps the conversation) and same sandbox (its files persist). |
| A turn ends | The worker stays, idle, with its session and sandbox, until torn down. |
| Sandbox or runner restarts | The worker continues in the same session; a running turn is marked interrupted. |
| **Tear down** (launcher) | The runner deletes the worker (Agents Hub: cancel, delete session, delete sandbox). space-hub keeps its result copy (§8.5). |
| The runner ends it itself (expiry, failure) | The card shows the last state and result. |

An idle worker may hold resources on the launcher's account (an Agents Hub worker keeps its sandbox: one of
the launcher's Launchpad app slots), so the launcher's card suggests tearing down finished workers.

## 5. The Worker Protocol (v1)

A runner is a base URL plus a bearer token. All bodies are JSON. The Agents Hub's task API (xo-agents PR #1)
is v1, unchanged, plus §5.3; other runners implement the same routes.

### 5.1 Routes

| Route | Does | Answer |
|---|---|---|
| `GET /api/worker` | describe the runner (§5.3) | 200 `{protocol, name, kind, capabilities}` |
| `POST /api/tasks {text, title?, repo?}` | start a worker | 201 `{task, result}` |
| `GET /api/tasks/:id` | its state and result | 200 `{task, result}` |
| `GET /api/tasks/:id/events?after=N` | its steps after `N` (at most 200) | 200 `{events, next}` |
| `POST /api/tasks/:id/messages {text}` | follow up (capability `followUp`) | 202 |
| `POST /api/tasks/:id/stop` | stop the running turn (capability `stop`) | 202 `{stopped: true}` or 200 `{stopped: false, reason}` |
| `DELETE /api/tasks/:id` | tear down | 200 `{deleted: true}` or 202 `{deleted: false, retrying: true}` |

- `task` = `{id, title, repo, status, createdAt, lastActivityAt}`; `status` is one of `running`, `done`,
  `stopped`, `failed`, `ending`. `result` = `{summary, links, error}` (`links`: URLs, e.g. pull requests).
- `POST /api/tasks` and `/messages` take an `Idempotency-Key` header: a repeat answers like the first call
  (same key, other request → 422).
- Errors: `{error: "<plain sentence>"}` with 400/401/403/404/409/422/429/5xx. 401 = the token is not valid
  (space-hub then says the runner needs reconnecting); 404 = no such worker (torn down); 409 = busy (follow up
  while running) or in progress.

### 5.2 Tokens

A token given to space-hub **sees only the workers it started** (list, read, steps, follow up, stop, tear
down: anything else is 404). A runner that cannot scope tokens is not a v1 runner. Revoking a token leaves its
workers on the runner (its owner can still see them there).

### 5.3 Describe yourself

```json
GET /api/worker
{
  "protocol": "worker/1",
  "name": "Priya's Agents Hub",
  "kind": "Agents Hub · OpenAI",
  "capabilities": { "followUp": true, "stop": true, "events": true, "repo": true, "connect": false }
}
```

`kind` is a free label; `protocol` lets space-hub refuse a runner it does not understand ("This runner speaks
worker/2; update space-hub"). An unknown capability is ignored; a missing one is `false`.

### 5.4 Capabilities

| Capability | When false |
|---|---|
| `followUp` | no Follow up on the card |
| `stop` | no Stop |
| `events` | no Steps; the card shows status and result only |
| `repo` | the launch tray does not ask for a repository |
| `connect` | the runner only connects by paste (§6.2) |

### 5.5 Steps (events)

Each event: `{seq, kind, at, …}`, `seq` rising. Known kinds, and what the card shows for each:
`user {text}`, `message {text}` (the agent's words), `thinking {text}`, `command {id, command}`,
`command_done {id, exitCode, output}`, `tool {id, name, args}`, `tool_done {id, name, ok, output}`,
`link {url, label}`, `note {text}`, `error {text}`, `turn {state, error}` (a turn ended). An unknown kind is
skipped. Output fields are clipped by the runner (the Agents Hub clips to 1,500 characters).

## 6. Connecting runners

### 6.1 Several per person

A person can connect several runners (e.g. "My Agents Hub" and, later, "My Coworker workspace"), name them,
and mark one as their default. The launch tray picks the default and offers the others.

### 6.2 Paste (phase 1, every runner)

1. On the runner: make a token that only sees what it starts (Agents Hub: Settings → Agent access → New token,
   "Only tasks it starts").
2. In space-hub: Settings → **Runners** → Add → address + token → **Connect**.
3. The web service checks it before saving: `https://` (or loopback for local runs); `GET /api/worker` answers a
   protocol it speaks; `GET /api/tasks` with the token answers 200. Plain messages for each failure ("That
   token is not valid for this runner", "The runner did not answer", "This is not a runner space-hub can use").
4. Saved (§7), named by default after `/api/worker`'s `name`.

### 6.3 Connect button (phase 2, runners with `connect`)

An OAuth-style consent flow, so no token is copied by hand; part of the protocol for runners that offer it:

1. space-hub makes a random `state` and a PKCE verifier (10 minutes, tied to the browser with an HttpOnly
   cookie, as GitHub and xo sign-in do) and redirects to
   `<runner>/connect?client=<space-hub origin>&redirect_uri=<space-hub>/-/runners/connect/callback&state=…&code_challenge=…`.
2. The person signs in to **their own runner** and sees "*<space-hub origin>* wants to start workers here
   and follow the workers it starts. [Approve] [Cancel]".
3. The runner redirects back with a one-time `code` (60 s, single use, bound to the challenge).
4. space-hub's server swaps it: `POST <runner>/api/connect/token {code, code_verifier, redirect_uri}` →
   a token scoped as §5.2. `DELETE <runner>/api/tokens/self` revokes it (Disconnect).

The token is never in a URL or the browser; the runner accepts only a `redirect_uri` on the origin it showed.

## 7. Storage

Private module tables, written only by admin reducers (`requireAdmin`) and read by the web service as the
admin over SQL, like `github_account` (`cli/src/admin.ts`).

```
runner (private)
  id            string, primary key   random
  owner         string, indexed       the person
  name          string                "My Agents Hub"
  kind          string                from /api/worker, a label
  url           string                https://… without a trailing slash
  sealed_token  string                AES-256-GCM(token), base64: iv | ciphertext | tag
  capabilities  string                JSON from /api/worker, refreshed on Test and on each launch
  is_default    bool
  connected_at  timestamp
  checked_at    timestamp             last successful call

worker (private)
  task_id       string, primary key   the runner's task id (the chat marker names only it)
  runner_id     string                which runner
  runner_url    string                its address, so reconnecting the same runner links the workers back
  launcher      string
  space, project, conversation  string
  title         string
  created_at    timestamp
  status        string                last known (§5.1), or "gone" after a tear down
  result        string                JSON {summary, links, error}, copied when a turn ends (§8.5)
  updated_at    timestamp
```

- Reducers: `runner_add`, `runner_update` (name, default, capabilities, token), `runner_delete`; `worker_add`,
  `worker_update`. `delete_builder` deletes the person's runners; their workers stay (the chat still names
  them, and the result copies stay readable).
- **Encryption key**: `SPACEHUB_SECRET_KEY` (32+ random bytes, base64), from the environment, **not**
  `/data`, so Sub-hub backups of `/data` hold only ciphertext. Without it, connecting runners is off and
  Settings says so. On a Launchpad template it is a `secret` parameter with `generate: random:48`.
- The web service decrypts a token only for the call it is about to make and keeps none in memory after it.
- Encrypted, although the hub's own sign-in tokens (`github_account`) are plain: those control space-hub; a
  runner token spends the person's money and acts on their accounts.

## 8. Launching and following workers

### 8.1 Launch

A person with at least one runner launches from any channel of a space they can write to (member, owner or
collaborator). The launch tray shows "Runs on <runner name> · <kind>" with a picker when they have several.
The web service starts the task on that runner (with an idempotency key), adds the `worker` row, then saves
the chat turn. Without a runner: "Connect a runner in Settings to launch workers" (with a link).

### 8.2 Where the worker is recorded

The chat turn ends with the same marker as today, `<!-- agenthub:task=<id> -->` (kept for file compatibility),
so the app's parsing does not change. The `worker` table is the source of truth for which runner, which space
and who launched it: anyone who can push to a project can write any marker, so the server never trusts a
marker by itself. A marker with no row is shown as "Unknown worker".

### 8.3 Following a worker

The card calls `/-/api/workers/<id>` and `/events` (renamed from `/-/api/agenthub/tasks/…`). The server finds
the row, checks the viewer is a member of its space, decrypts the **launcher's** runner token and asks that
runner. Viewers never hold anyone's token and need no runner of their own.

### 8.4 Who may do what

| Action | Who |
|---|---|
| See the card, its steps and result | signed-in members, owners and collaborators of the worker's space |
| Launch | a member, owner or collaborator of the space, on a runner of their own |
| Follow up, Stop, Tear down | the launcher only (and only where the runner has the capability) |

### 8.5 The result copy

Whenever the server reads a worker and finds it no longer running, it stores its status and result in the
`worker` row (and again after each follow-up's turn). When the runner cannot give the worker, the card shows
the copy:
- torn down (404): "Torn down" + the last result;
- the runner disconnected, its token refused (401) or no answer: "<launcher>'s runner is not connected" (or
  "did not answer") + the last result.

Steps are not copied (they can be large and hold sandbox output).

### 8.6 Disconnecting a runner

Settings → Disconnect deletes the `runner` row (phase 2 also revokes the token: `DELETE /api/tokens/self`).
Its workers keep running on the runner; their cards show the result copy and say the runner is not
connected, until the same runner (same address) is connected again, when the rows are linked back.

## 9. Settings and chat UI (space-hub app)

- **Settings → Runners**: the list (name, kind, address, default, connected at, last used, Test, Disconnect),
  **Add a runner** (address + token; phase 2: a Connect button for runners with `connect`), and **Your
  workers** (each with its runner, space and status, so idle ones are easy to find and tear down). Without
  `SPACEHUB_SECRET_KEY`: "Connecting runners is not set up on this hub."
- **Launch tray**: "Runs on <runner> · <kind>", a picker for several, and the repository field only when the
  runner has `repo`.
- **Worker card**: "on <launcher>'s <runner kind>"; Follow up, Stop and Tear down only for the launcher and only
  for supported capabilities; Steps only with `events`; the result copy when the runner cannot give the worker;
  for the launcher, "Done with it? Tear down to free the runner's resources" once idle.
- `GET /-/api/workers?space=` answers `{runners: [{id, name, kind, default}], canLaunch}` for the viewer.

## 10. Deployment and compatibility

- A new Launchpad app (Blank template for now). Port 3000, storage at `/data` (or `SPACETIME_ROOT` matching
  the mount), health `/healthz`, `SPACEHUB_SECRET_KEY`
  (`node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`), plus the usual settings.
  No runner settings: members connect their own.
- Client protocol: the new tables are private and the reducers admin-only; the generated bindings change (new
  reducers), so `BINDINGS_HASH` is updated. Old CLIs keep working, so `PROTOCOL` is not bumped.
- **Upstream (quirq-ai/space-hub, hub.quirq.dev)**: removing the shared hub changes that deployment: its
  `SPACEHUB_AGENTHUB_*` settings stop doing anything and its existing workers become "Unknown worker". Before
  this merges upstream, its members connect their own runners; existing workers stay visible in the old hub's
  own UI.

## 11. Runners

### 11.1 The Agents Hub (this round; xo-agents `hub-user/`, its own PR)

- **Scoped tokens** (§5.2): `api_tokens` gains `scope` (`all`, today's; or `own`), `chats` gains `token_id`;
  with an `own` token every `/api/tasks*` route sees only its own chats. Settings → New token: "Only tasks it
  starts (for apps like space-hub)".
- **`GET /api/worker`** (§5.3): `{"protocol": "worker/1", "name": "<owner>'s Agents Hub", "kind": "Agents Hub ·
  OpenAI", "capabilities": {"followUp": true, "stop": true, "events": true, "repo": true, "connect": <phase 2>}}`.
- **Connect flow** (phase 2, §6.3): `/connect`, `POST /api/connect/token`, `DELETE /api/tokens/self`.

### 11.2 xo-space / xo-coworker (later; sketch)

A Coworker workspace runs a small **bridge** that speaks the Worker Protocol: a task starts Claude Code, Codex
or OpenClaw in the workspace (in its own folder, or a fresh sandbox), streams its steps as §5.5 events, takes
follow-ups as new turns of the same run, and tears down by stopping it and cleaning its folder. `kind` e.g.
"Coworker · Claude Code". Built in xo-coworker; no space-hub change.

### 11.3 claude-code container (later; sketch)

The claude-code template (Remote Control) gains the same bridge, so a person's own Claude Code container can
take workers: `kind` "Claude Code · Remote Control".

## 12. Later: sponsored runners

A space owner shares one of their runners with the space ("members of acme may launch on my Agents Hub"):
opt-in per space, revocable, and the launch tray then offers "acme's runner (shared by priya)" beside the
person's own. The card always says whose account a worker runs on. Steering stays with the launcher; the
sponsor can stop or tear down any worker on their runner. The `runner` table gains a `shared_with` list;
nothing else in this design changes.

## 13. Tests

- **Protocol**: a fake runner per test that speaks `worker/1`; one that speaks `worker/2` is refused with the
  message; capabilities hide the matching buttons and routes (403 from space-hub for an unsupported action).
- **Storage**: seal/open round trip; a wrong key or tampered ciphertext is refused; no plain token in the
  tables; several runners per person, one default; `delete_builder` removes the runners and keeps the
  workers; only the admin can call the `runner_*` and `worker_*` reducers.
- **Connect (paste)**: https only; `/api/worker` and the token are checked before saving; failure messages;
  Test; Disconnect; nothing secret in any answer or log.
- **Launch**: the picked runner is called with its token (two fake runners for one person); refused without a
  runner; the `worker` row is written before the chat turn; a retry with the same key starts one worker.
- **Following**: a viewer's request goes to the launcher's runner with the launcher's token; non-members are
  refused; a marker without a row is "Unknown worker".
- **Result copy**: a finished turn is copied; after tear down (404), disconnect, 401 or no answer, the card gets
  the copy; steps are not copied.
- **Permissions**: follow up, stop and tear down by anyone but the launcher → 403.
- **Agents Hub** (its own PR): `own` tokens see only their chats on every task route; `all` tokens unchanged;
  `/api/worker`; connect flow (phase 2).
- **End to end**: two real Agents Hubs (two people), one space-hub: B launches, C watches and cannot stop it, B
  follows up (same session: it remembers), B tears down (C still sees the result), B disconnects and
  reconnects.

## 14. Phases and rough effort

1. **Phase 1**: the Worker Protocol (§5) as space-hub's only way to reach runners; runner and worker storage,
   encryption, Settings → Runners (paste), launch tray picker, routing, permissions, result copy, removing the
   shared hub (~2.5 days); the Agents Hub's scoped tokens and `/api/worker` (~0.5 day); tests and
   a real two-hub run (~0.5 day).
2. **Phase 2**: the connect button, on both sides (~1–1.5 days).
3. **Phase 3, last** (decided by the user: only once phases 1–2 are built and tested): workers that work in the
   space-hub project itself (§16) (~2–2.5 days across space-hub, the Agents Hub, Launchpad and the executor).
4. **Later**: sponsored runners (§12); the xo-coworker bridge (§11.2); the claude-code bridge (§11.3).

## 15. Decisions (2026-11-03, by the user)

1. Follow up, stop and tear down: the launcher only, for now.
2. No operator-wide shared hub.
3. Keep a copy of each worker's result now (§8.5).
4. No per-space limits on workers.
5. Workers run on the launcher's account by default; running on a project owner's account only as an explicit,
   later opt-in (sponsored runners, §12).
6. Agent-agnostic: space-hub talks to runners only through the Worker Protocol; the Agents Hub is the first
   runner, others (xo-space / xo-coworker, claude-code, …) follow on the same protocol.
7. Workers that work in the space-hub project itself come last (phase 3), after connecting, launching,
   following and tearing down are built and tested.

## 16. Phase 3: workers that work in the space-hub project (sketch)

Today a worker works on GitHub. In phase 3 the launch tray also offers **"Work in this project on space-hub"**,
from a proven trial (the swarm playbook, 2026-10-30: an Agents Hub sandbox running `spacehub agent run`). What
changes from that trial, so it is safe to offer from a chat:

- **A worker identity per launch**, not a spacehub agent: space-hub mints a fresh identity that can push only to
  the launch's project, only to its own branch `worker/<id>` (or, opt-in, live on the default branch for planned
  swarms with file ownership), and stops working at tear down. Commits read "worker-<id> (for <launcher>)".
  Module: a private `worker_identity` table and a push rule that checks it.
- **The token travels in the environment, never in the task text**: the protocol's start call gains an optional
  `workspace {type: "spacehub", server, project, branch, token}` for runners with the capability
  `spacehubWorkspace`. The runner puts it in the sandbox's environment and stores and logs none of it.
- **The agent never sees the token**: the runner's own process (for the Agents Hub, the executor's supervisor)
  clones the project and runs autosync as the worker identity; the agent only edits files in
  `/workspace/<space>/<project>`, with the playbook's ground rules (never run git).
- **The card shows the work**: commits by the worker, files changed, the branch; later a Merge for the launcher.

Changes outside space-hub:

| Where | Change |
|---|---|
| Agents Hub (`hub-user`) | `POST /api/tasks` takes `workspace`, passes it to the executor create, never stores or logs it (redactor) |
| Launchpad (`xo-swarm-api` `launchpad/agents.py`) | the executor create takes the optional fields and maps them to template parameters (a deploy) |
| Executor + `agents-executor` template | secret parameters → `SPACEHUB_SERVER` / `SPACEHUB_TOKEN`; the spacehub CLI in the image; the supervisor clones and autosyncs before starting the agent, keeping both out of the agent's environment |
