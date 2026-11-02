# Workers on your own runners (phase 1): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workers launched from a chat run on a runner of the person who launches them, reached only through the
Worker Protocol; the operator-wide shared Agents Hub is removed.

**Architecture:** Two private module tables (`runner`, `worker`) written by admin-only reducers and read by the
web service over admin SQL, like `github_account`. The web service gets a vendor-free Worker Protocol client
(`workerclient.ts`), token sealing (`seal.ts`), a store over the admin API (`runnerstore.ts`) and the HTTP routes
(`workers.ts`, replacing `agenthub.ts`). The app gets Settings → Runners, a runner picker in the launch tray and a
capability-aware worker card with the result copy.

**Tech Stack:** SpacetimeDB TypeScript module (vitest harness), Node 22 web service (`node --test`, type
stripping), React app (esbuild, `node --test` for pure libs). First runner: the Agents Hub as changed by xo-agents
`feat/worker-protocol` (Plan A).

**Spec:** `docs/specs/2026-11-03-workers-on-your-own-runners-design.md` (this worktree). Phase 1 = §14 item 1.

## Global Constraints

- Work in the WSL clone `~/space-hub-agents` (Ubuntu; `\\wsl.localhost\Ubuntu\home\sigma\space-hub-agents` from
  Windows), branch `feat/per-user-agents-hub`; run every command there in WSL (Node 22 via nvm:
  `. ~/.nvm/nvm.sh`). Commit only when the user says so; no AI co-author lines.
- Protocol: the client accepts `protocol === "worker/1"` only; any other → "This runner speaks <p>; update
  space-hub." Capability keys: `followUp`, `stop`, `events`, `repo`, `connect`; missing = false; unknown ignored.
  Unknown response fields are ignored (the Agents Hub's `/stop` also returns `ok`).
- Runner URL: `https://…` (or `http://127.0.0.1|localhost[:port]` for local runs), stored without a trailing slash.
- `SPACEHUB_SECRET_KEY`: base64 of ≥32 random bytes; sealing is AES-256-GCM with a 12-byte random IV, stored as
  base64 of `iv | ciphertext | tag`. Without the key, connecting runners is off: "Connecting runners is not set
  up on this hub."
- No runner token in any HTTP answer, log line, error text, chat file or activity row.
- Permissions: see / steps = signed-in members, owners, collaborators of the worker's space; launch = a writer of
  the project's space with a runner of their own; follow up, stop, tear down = the launcher only.
- The chat marker stays `<!-- agenthub:task=<id> -->`. A marker with no `worker` row → "Unknown worker".
- Removed: `SPACEHUB_AGENTHUB_URL`, `SPACEHUB_AGENTHUB_TOKEN`, `SPACEHUB_AGENTHUB_SPACES`, the xo-linked rule,
  `cli/src/agenthub.ts`, routes `/-/api/agenthub*`.
- space-hub runs in Docker (a Linux container), as an image and later a Launchpad template, so tests run where it
  runs: in Linux (WSL Ubuntu), on a checkout with LF line endings. No workarounds for running it natively on a
  developer's Windows machine. Baseline there before Task 1 (module 69/70 with one known failure, cli 172/172,
  app 30/30); no task may add a failure.

## Review Focus

- A runner token reaching the browser through an error: an upstream error whose text echoes the bearer or a
  `hub_…` value must be redacted before it is returned (Task 3).
- Two people's runners on the same Agents Hub URL (one hub shared by two space-hub users who each pasted a token):
  each worker must be read with its own launcher's token, never the other's (Task 5).
- A worker whose launcher left the space (removed as member): the card still shows to members, but follow up /
  stop / tear down by the former member are refused (Task 5).
- Disconnect then reconnect the same URL: the old workers are linked back to the new runner row (Task 5).
- A runner that answers `/api/worker` but 401s on `/api/tasks` (a token for another hub): refused at connect with
  "That token is not valid for this runner" (Task 5).

---

### Task 1: Private `runner` and `worker` tables with admin reducers

**Files:** Modify `module/src/index.ts` (tables, reducers, `deleteBuilder`), `module/src/protocol.ts`
(`BINDINGS_HASH` only), regenerate `cli/src/module_bindings` (`cd cli && npm run generate`); Test
`module/test/runners.test.ts` (new, vitest harness as in `xo.test.ts`).

**Interfaces:** Produces (module, admin-only via `requireAdmin`):
- `runner` (private): `id: string` (pk), `owner: string` (btree), `name`, `kind`, `url`, `sealedToken`,
  `capabilities` (JSON string), `isDefault: bool`, `connectedAt`, `checkedAt` (timestamps).
- `worker` (private): `taskId: string` (pk), `runnerId: string` (btree), `runnerUrl: string`, `launcher`
  (btree), `space`, `project`, `conversation`, `title`, `status`, `result` (JSON string), `createdAt`, `updatedAt`.
- Reducers: `runnerAdd({id, owner, name, kind, url, sealedToken, capabilities, isDefault})`,
  `runnerUpdate({id, name, sealedToken, capabilities, isDefault, checkedAt})` (empty string = keep),
  `runnerDelete({id})`, `workerAdd({taskId, runnerId, runnerUrl, launcher, space, project, conversation, title})`,
  `workerUpdate({taskId, status, result, runnerId})` (`runnerId` "" = keep).
- One default per owner: `runnerAdd`/`runnerUpdate` with `isDefault: true` clears the owner's other defaults; a
  person's first runner is the default.
- `deleteBuilder` deletes the builder's runners and keeps their workers.

- [ ] **Step 1: Failing tests** — `runnerAdd` by a non-admin throws `/only the hub admin/`; add two runners for
  `priya` → the first is default, `runnerUpdate({isDefault: true})` on the second moves the default; `runnerDelete`
  removes the row; `workerAdd` then `workerUpdate({status: "done", result: '{"summary":"ok"}'})` round-trips;
  `deleteBuilder` as priya removes her runners and keeps her workers; a duplicate `workerAdd` with the same
  `taskId` throws.
- [ ] **Step 2: Run** `cd module && npm test -- runners` → FAIL.
- [ ] **Step 3: Implement**; regenerate bindings; set `BINDINGS_HASH` to the hash `cd cli && npm test` prints;
  `PROTOCOL` unchanged (old CLIs use none of this).
- [ ] **Step 4: Run** module and cli suites → the new tests PASS, no new failures.
- [ ] **Step 5: Commit** — "Module: private runner and worker tables, admin-only"

### Task 2: Sealing runner tokens

**Files:** Create `cli/src/seal.ts`; Test `cli/test/seal.test.ts`.

**Interfaces:** Produces `sealKey(env = process.env): Buffer | null` (null when `SPACEHUB_SECRET_KEY` is unset;
throws "SPACEHUB_SECRET_KEY must be base64 of at least 32 bytes" when shorter), `seal(key: Buffer, plain: string):
string`, `open(key: Buffer, sealed: string): string` (throws "This runner's token cannot be read; connect it
again." on a wrong key or tampering). AES-256 uses the first 32 bytes of the decoded key.

- [ ] **Step 1: Failing tests** — round trip; two seals of one value differ (random IV); a flipped byte → throws;
  another key → throws; unset → `sealKey` null; 16-byte key → throws; the sealed text never contains the plain.
- [ ] **Step 2: Run** `cd cli && node --experimental-strip-types --test test/seal.test.ts` → FAIL.
- [ ] **Step 3: Implement** with `node:crypto` `createCipheriv('aes-256-gcm', …)`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — "Seal runner tokens with SPACEHUB_SECRET_KEY (AES-256-GCM)"

### Task 3: The Worker Protocol client

**Files:** Create `cli/src/workerclient.ts`; Test `cli/test/workerclient.test.ts` (a fake runner on
`http://127.0.0.1:<port>`, adapted from the fake hub in `cli/test/agenthub.test.ts`).

**Interfaces:** Produces, all vendor-free:
- `type Describe = { protocol: string; name: string; kind: string; capabilities: Capabilities }`,
  `type Capabilities = { followUp: boolean; stop: boolean; events: boolean; repo: boolean; connect: boolean }`.
- `checkRunnerUrl(raw: string): string` (normalised; throws `RunnerError(400, "Use an https:// address.")`).
- `class RunnerError extends Error { status: number }` — status = the code space-hub should answer.
- `runner(url: string, token: string, fetchImpl = fetch)` → `{ describe(): Promise<Describe>, list(): Promise<unknown>,
  start(input: {text, title?, repo?}, key: string), get(id), events(id, after: number), followUp(id, text, key),
  stop(id), teardown(id) }`, each resolving to the parsed JSON (`get`/`start` → `{task, result}`).
- Error mapping (status from runner → `RunnerError`): no answer/timeout (20 s) → 502 "<name or host> did not
  answer"; 401/403 → 502 "That token is not valid for this runner" (and `.auth = true`); 404 → 404 "This worker
  has ended and was torn down."; 409/422/400 → same status with the runner's `error` text; ≥500 → 502 with its
  text. Every message passes through `redactToken(text, token)`, which removes the exact token and any
  `hub_[A-Za-z0-9_-]{8,}` / `Bearer \S+`.
- `describe()` refuses `protocol !== "worker/1"` (RunnerError 400 "This runner speaks <p>; update space-hub.")
  and fills missing capabilities with false.

- [ ] **Step 1: Failing tests** — describe ok / wrong protocol / missing capability → false; start sends
  `Authorization: Bearer <token>` and `Idempotency-Key`; each error mapping above; an upstream error text that
  echoes the token comes back redacted; http:// to a non-loopback host refused by `checkRunnerUrl`.
- [ ] **Step 2: Run** `cd cli && node --experimental-strip-types --test test/workerclient.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — "Worker Protocol client (worker/1), vendor-free"

### Task 4: Runner store over the admin API

**Files:** Create `cli/src/runnerstore.ts`; Test `cli/test/runnerstore.test.ts`.

**Interfaces:**
- Consumes: `select`, `call` from `cli/src/admin.ts`; Task 1's reducers and columns; Task 2's `seal`/`open`.
- Produces: `interface RunnerStore` with `listRunners(owner): Promise<Runner[]>`, `getRunner(id)`,
  `addRunner(r)`, `updateRunner(id, patch)`, `deleteRunner(id)`, `listWorkers({launcher?, space?})`,
  `getWorker(taskId)`, `addWorker(w)`, `updateWorker(taskId, patch)`, `runnersAt(url)`; `adminStore(cfg:
  AdminHttp): RunnerStore` (SQL + reducers; every interpolated value checked against its pattern first — ids
  `[a-f0-9]{16}`, usernames as `USERNAME`, task ids `[A-Za-z0-9_-]{1,100}`, urls already normalised and quoted
  with `'` doubled); `memoryStore(): RunnerStore` for tests. `Runner` = the row with `capabilities` parsed and
  **without** the token; `sealedTokenOf(id): Promise<string>` is the only way to read it.
- [ ] **Step 1: Failing tests** — against `memoryStore()` and against `adminStore()` with a stand-in SQL/call HTTP
  server (as `cli/test/xo.test.ts` does): rows round-trip; `Runner` objects carry no token field; a username with a
  quote is refused before any SQL is sent.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — "Runner store over the hub admin API"

### Task 5: Routes: runners and workers (replacing agenthub)

**Files:** Create `cli/src/workers.ts`; Modify `cli/src/web.ts` (wiring; remove `agenthub` import, `AGENTHUB`,
`xoLinked` use for agents); Delete `cli/src/agenthub.ts`, `cli/test/agenthub.test.ts`; Test
`cli/test/workers.test.ts`.

**Interfaces:**
- Consumes: Tasks 2–4; deps `sessionOf`, `appendChat`, `sameOrigin`, plus new `memberOf(session, space):
  Promise<boolean>` (owner, member or collaborator of any project in it) and `canWrite(session, project):
  Promise<boolean>` (from `spacesOf` and `project_member`).
- Produces `handleWorkers(cfg: {key: Buffer | null, store: RunnerStore}, deps, req, res, url): Promise<boolean>`:

| Route | Who | Does |
|---|---|---|
| `GET /-/api/runners` | signed in | `{enabled, runners: Runner[]}` (own) |
| `POST /-/api/runners {url, token, name?}` | signed in, same origin | `checkRunnerUrl`, `describe()`, `list()` (401 → "That token is not valid for this runner"), seal, add (first = default); relinks the owner's workers whose `runnerUrl` equals `url` to the new id |
| `PATCH /-/api/runners/<id> {name?, default?}` | owner | rename / make default |
| `POST /-/api/runners/<id>/test` | owner | `describe()` + `list()`; refreshes capabilities and `checkedAt` |
| `DELETE /-/api/runners/<id>` | owner | delete the row (workers kept) |
| `GET /-/api/workers?space=<s>` | signed in | `{runners: [{id,name,kind,default,capabilities}], canLaunch}` (`canLaunch` = has a runner and `memberOf`) |
| `GET /-/api/workers?mine=1` | signed in | the viewer's workers (Settings → Your workers) |
| `POST /-/api/workers {space, project, conversation, text, repo?, title?, runner?}` | writer of the project, same origin | runner = `runner` or the default; `start()` with an idempotency key; `addWorker` before `appendChat`; answer `{task, result, saved}` |
| `GET /-/api/workers/<task>` | member of the worker's space | `get()` with the **launcher's** runner token; terminal status → `updateWorker` (result copy); on 404/401/no runner/no answer → `{task: copy, result: copy, state: "gone"|"disconnected"|"unreachable", launcher, runner: {name, kind}}` |
| `GET /-/api/workers/<task>/events?after=N` | member | `events()` if capability `events`, else 404 |
| `POST …/messages`, `…/stop`, `DELETE …` | launcher only, same origin, capability `followUp`/`stop` | as the protocol; after a 200 tear down, `updateWorker(status "gone")` |

  Every answer carries `launcher` and `runner {name, kind, capabilities}` so the app can show "on <launcher>'s
  <kind>" and hide unsupported buttons. Without `cfg.key`: runner routes answer 503 "Connecting runners is not set
  up on this hub."
- [ ] **Step 1: Failing tests** (two fake runners, `memoryStore`, stub deps for two people) — each row of the table;
  the Review Focus cases: one Agents Hub URL with two people's tokens (each worker read with its launcher's token —
  assert the bearer the fake saw); a former member's stop → 403; disconnect + reconnect relinks; a token valid for
  `/api/worker` but 401 on `/api/tasks` → refused; no response body or thrown message contains a token.
- [ ] **Step 2: Run** `cd cli && node --experimental-strip-types --test test/workers.test.ts` → FAIL.
- [ ] **Step 3: Implement**; wire into `web.ts` in place of `handleAgentHub`; `cfg.key = sealKey()` and
  `cfg.store = adminStore({adminToken: ADMIN_TOKEN, http: INTERNAL_HTTP, db: DB})`.
- [ ] **Step 4: Run** the cli suite → new tests PASS, no new failures.
- [ ] **Step 5: Commit** — "Runners and workers: routes over the Worker Protocol; remove the shared Agents Hub"

### Task 6: App: Settings → Runners, launch picker, worker card

**Files:** Rename `app/src/lib/agenthub.ts` → `app/src/lib/workers.ts` (paths `/-/api/workers`, types below),
`app/src/hooks/use-agenthub.ts` → `use-workers.ts`; Modify `app/src/pages/chat.tsx` (status, launch tray picker,
copy), `app/src/components/worker-card.tsx`, `app/src/pages/settings.tsx` (a Runners section above Sub-hubs, and
Your workers); Test `app/test/workers.test.ts` (renamed from `agenthub.test.ts`, pure functions).

**Interfaces:**
- Consumes: Task 5's answers.
- Produces (lib, pure): `type Capabilities`; `type RunnerInfo = {id, name, kind, default, capabilities}`;
  `type WorkerDetail = {task, result, state?: "gone"|"disconnected"|"unreachable", launcher, runner: {name, kind,
  capabilities}}`; `toWorkerDetail(value: unknown): WorkerDetail`; `cardActions(detail, me): {steps, followUp,
  stop, tearDown}` (booleans: launcher only, capability-gated, by status); `launchNote(runners): string`
  ("Runs on <name> · <kind>" / "Connect a runner in Settings to launch workers"); `cardHeadline(detail, me)`
  ("on your <kind>" / "on <launcher>'s <kind>"); `stateNote(detail)` ("Torn down · result kept" /
  "<launcher>'s runner is not connected" / "<launcher>'s runner did not answer" / "").
- UI copy (exact): Settings heading "Runners"; empty: "Connect a runner to launch workers from chats. Make a token
  on the runner that only sees the tasks it starts (Agents Hub: Settings → Agent access → Only tasks it starts),
  then paste its address and token here."; buttons "Connect", "Test", "Make default", "Disconnect"; Your workers
  hint once idle (launcher): "Done with it? Tear down to free the runner's resources."
- [ ] **Step 1: Failing tests** — `cardActions`: a viewer gets only `steps` (when `events`); the launcher gets
  stop while running and follow up / tear down when idle, each only with its capability; `cardHeadline` both
  forms; `stateNote` for each state; `launchNote` with 0, 1 and 2 runners; `launchOf` still parses the unchanged
  marker.
- [ ] **Step 2: Run** `cd app && npm test` → FAIL.
- [ ] **Step 3: Implement** lib, hook, tray picker (a `<select>` when >1 runner; repo field only with `repo`),
  card (`stateNote` above the result copy; buttons from `cardActions`), Settings sections.
- [ ] **Step 4: Run** `cd app && npm test && npm run typecheck && npm run build` → PASS.
- [ ] **Step 5: Commit** — "App: Settings → Runners, a runner picker, launcher-only worker actions, result copy"

### Task 7: Docs and the real two-hub run

**Files:** Modify `README.md` (replace "Agents launched from chat" with "Workers on your own runners"; settings
table: remove the three `SPACEHUB_AGENTHUB_*` rows, add `SPACEHUB_SECRET_KEY`; Layout: `workers.ts`,
`workerclient.ts`, `runnerstore.ts`, `seal.ts`); a scratch script outside the repo for the run.
- [ ] **Step 1: Docs.**
- [ ] **Step 2: Real run** — space-hub server image built from this branch on Linux (WSL Docker or a test
  Launchpad app) with `SPACEHUB_SECRET_KEY`; two Agents Hubs from Plan A's branch (or the deployed one plus a local one),
  two builders B and C in one org. B connects a runner (paste, "Only tasks it starts" token), launches from a
  channel; C sees the card "on B's Agents Hub · OpenAI" with no Stop; B follows up (same session); B tears down;
  C still sees "Torn down · result kept"; B disconnects and reconnects → card live again.
  Expected: every step as described; no token in any browser response (check the network log).
- [ ] **Step 3: Commit** — "Docs: workers on your own runners"
