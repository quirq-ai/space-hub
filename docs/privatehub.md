# Private hub (branch `privatehub`)

The same spacehub, with nothing public. Every request needs the hub token of
someone signed in with XO (Clerk, through the xo server's sign-in), or of an
agent one of them made. Builders come only from XO: GitHub sign-in and open
sign-up are off.

## How the gate works

```
browser / CLI / git ──▶ Caddy (:3000) ──forward_auth──▶ web service GET /-/gate (cli/src/gate.ts)
                          │                                 │ 204: verified token, identity on the allowlist
                          │◀────────────────────────────────┘ 303 to /-/login (pages) or 401 (everything else)
                          ▼
              SpacetimeDB (websocket, module pages) and the web service
```

- **Where the token comes from:** `Authorization: Bearer` (CLI, git,
  SpacetimeDB's websocket-token endpoint), the `spacehub_session` cookie (the
  website), or `?token=` (the websocket itself).
- **What is checked:** an ES256 signature by this hub's own SpacetimeDB key
  (tokens from other OIDC issuers are refused, though SpacetimeDB would take
  them), not expired, and an identity on the allowlist.
- **The allowlist** (read with the admin token every 30 s, and at once when an
  unknown identity knocks, at most every 2 s): builders in `xo_link` (signed
  in with XO), builders in `xo_agent` (made by xo before GitHub was needed),
  agents those builders created, and the hub admin.
  `SPACEHUB_PRIVATE_BUILDERS` narrows it to named builders and their agents.
- **Open without a token:** `/healthz`, `GET /-/login` (offers only Sign in
  with XO), `/-/login/xo` and its callback, `/-/api/xo/v1/*` (needs
  `SPACEHUB_XO_KEY` itself) and the app's static files `/-/app/*.css|js|svg|...`.
- **Fails closed:** no admin token, or the database not answering, gives 503.
- The browser session lasts `SPACEHUB_SESSION_DAYS` (default 7), then XO's
  sign-in again.
- The server refuses to start without `SPACEHUB_XO_KEY` (32+ characters), and
  forces `SPACEHUB_ACCOUNTS=xo`.

Changed from `main`: `cli/src/gate.ts` (new), `cli/test/gate.test.ts` (new),
`docker/server.Caddyfile`, `docker/server-entrypoint.sh`, `cli/src/web.ts`
(gate first, XO-only sign-in page, GitHub sign-in and sign-up off, shorter
session), `scripts/private-smoke.sh` (new). Keep the diff this small so `main`
merges in cleanly.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPACEHUB_XO_KEY` | required | Shared with the xo server (its `XO_HUB_KEY`). Without it the hub does not start |
| `SPACEHUB_XO_URL` | `https://xo.quirq.dev` | The xo server whose Clerk sign-in the hub uses |
| `SPACEHUB_PRIVATE_BUILDERS` | unset (every XO builder) | Comma-separated builder names allowed in; their agents too |
| `SPACEHUB_SESSION_DAYS` | `7` | How long a browser stays signed in |
| `SPACEHUB_ACCOUNTS` | forced to `xo` | Any other value is ignored, with a warning |

`SPACEHUB_GITHUB_CLIENT_ID` and `_SECRET` are unused here.

## Production checklist

### Blockers (nobody can sign in until these are done)

1. **The xo server must serve this hub.** Sign in with XO ends with the xo
   server making the builder *on its configured hub* (`POST /login/hub`, then
   the hub's `/-/api/xo/v1/agents/...`). If the xo server only knows
   hub.quirq.dev, builders land there and this hub answers "XO named the
   builder ..., which this hub does not have". Either run a second xo server
   for the private hub, or teach the xo server to pick the hub by callback.
   Its code is not in this workspace, so this was not checked.
2. **Shared key:** generate a new key (`openssl rand -base64 48`), set it as
   `SPACEHUB_XO_KEY` here and as `XO_HUB_KEY` on that xo server. Do not reuse
   the public hub's key.
3. **Clerk redirect:** add `https://<private hub>/-/login/xo/callback` to the
   redirect URLs of the Clerk OAuth application xo login uses, and set the xo
   server's `XO_HUB_LOGIN_REDIRECT` to it. The button shows only while the xo
   server's `GET /login` offers exactly this callback.
4. **GitHub connected in XO:** every person needs a GitHub account connected
   to their XO account; without one the sign-in stops at "Connect GitHub".

### Deployment

5. **A new XO app**, not the public hub's: its own registry project
   (`registry.xo.builders/<project>/app`), app port 3000, its own persistent
   volume at `/data`. Never point it at the public hub's data.
6. **Build and push** from this branch:
   `docker build --platform linux/amd64 -t registry.xo.builders/<project>/app:latest .`
   then `docker push ...`. Run `cd cli && npm test` and build the image before
   every deploy (tests passing does not prove the image builds).
7. **Domain and TLS:** a hostname (for example a CNAME like
   `privatehub.quirq.dev`) with TLS at the platform's ingress. The ingress must
   send `X-Forwarded-Proto: https`, or session cookies lose `Secure`.
8. **Set `SPACEHUB_PRIVATE_BUILDERS`.** XO accounts are open sign-up, so
   without it anyone who makes an XO account and connects GitHub gets in.
9. **Optional:** `SPACEHUB_SECRET_KEY` (runners and workers; never change it
   once set), `SPACEHUB_PUBLIC_URL`, `SPACEHUB_LAUNCHPAD_API`, backups
   (`SPACEHUB_BACKUP_OF` container, whose `SPACEHUB_TOKEN` must be an allowed
   builder's).

### Clients

10. **CLI and git:** the CLI's default server is `wss://hub.quirq.dev`. Use
    `spacehub auth login --with-token --server wss://<private hub>` with the
    token from the website or `xo login`; `quirq://<private hub>/...` remotes
    then work. Older CLIs work too (the gate reads the token they already send).
11. **`xo login`** must know the private hub's address to hand out its token.
12. **Agents launched by XO Swarm** use `spacehub agent token`; the agent must
    be made by an allowed builder.

### Verify after deploy

13. `scripts/private-smoke.sh https://<private hub>`: every stranger check
    must pass. Then sign in with XO in a browser, copy the token
    (`spacehub auth token`) and run it again with `SPACEHUB_TOKEN=...`.
14. In a private window, open a deep link (`/<space>/<project>`): it must land
    on Sign in, then come back to that page after XO.

## Known limits

- **Revocation:** hub tokens never expire. Taking someone off
  `SPACEHUB_PRIVATE_BUILDERS` locks them out within 30 s. Without that list,
  deleting their XO account does not remove their `xo_link` row, so they keep
  access; ending a Clerk session does not sign them out of the hub either.
- **Pushed HTML pages** preview on the hub's own domain. In a private hub a
  page pushed by one member runs with the viewer's cookies on that domain. A
  separate raw-content domain would close this (open on `main` too).
- **Copy:** some module-rendered pages (the guide) still mention GitHub
  sign-in. Cosmetic: those routes are gated.
- Each request costs one extra local hop (the gate); the allowlist costs five
  small SQL reads every 30 s.
