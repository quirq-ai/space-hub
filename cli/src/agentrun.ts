// spacehub agent run: an agent at work. One folder holds the agent's own
// space (its definition) and every space it is connected to, each a space
// folder kept current by autosync, pushing as the agent:
//
//   <dir>/<agent>/home/...        its own projects
//   <dir>/<space>/<project>/...   each connected space
//
// One connection per space, so each shows the agent as running there
// ("agent" presence, with the host). Connections made or dropped while it
// runs are picked up. XO Swarm starts this in a workspace with the agent's
// token in SPACEHUB_TOKEN.
import fs from 'node:fs';
import path from 'node:path';
import { connectTo, errorMessage, projectsIn, tables, type Conn } from './conn';
import { cloneProject, findManifest, SpaceSync, writeManifest } from './spacesync';

const HEARTBEAT_MS = 60_000;

export interface AgentRunOptions {
  server: string;
  db: string;
  token: string; // the agent's
  agent: string;
  dir: string;
  intervalMs: number;
  host: string;
  log: (line: string) => void;
}

interface Running {
  conn: Conn;
  sync: SpaceSync;
  beat: ReturnType<typeof setInterval>;
}

export class AgentRun {
  private o: AgentRunOptions;
  private spaces = new Map<string, Running | 'starting'>();
  private main: Conn | null = null;
  private stopping = false;
  private env: Record<string, string>;

  constructor(options: AgentRunOptions) {
    this.o = options;
    // git (and git-remote-quirq) push as the agent, whatever else is set up.
    this.env = { SPACEHUB_TOKEN: options.token, SPACEHUB_SERVER: options.server, SPACEHUB_DB: options.db, SPACEHUB_HOME: path.join(options.dir, '.spacehub', 'home') };
  }

  async run() {
    fs.mkdirSync(this.o.dir, { recursive: true });
    const { conn } = await connectTo(this.o.server, this.o.db, this.o.token, { reconnect: true });
    this.main = conn;
    const me = this.o.agent;
    conn.db.spaceRole.onInsert((ctx, r) => {
      if (r.member === me && ctx.event.tag !== 'SubscribeApplied') void this.start(r.space);
    });
    conn.db.spaceRole.onDelete((ctx, r) => {
      if (r.member === me && ctx.event.tag !== 'UnsubscribeApplied') void this.drop(r.space);
    });
    const connected = await new Promise<string[]>((resolve, reject) =>
      conn
        .subscriptionBuilder()
        .onApplied(() => resolve([...conn.db.spaceRole.iter()].filter(r => r.member === me).map(r => r.space)))
        .onError(ctx => reject(new Error(`subscription failed: ${(ctx as { event?: unknown }).event}`)))
        .subscribe(tables.spaceRole.where(r => r.member.eq(me)))
    );
    for (const space of [me, ...connected]) await this.start(space);
    await new Promise<void>(resolve => {
      const stop = async () => {
        this.stopping = true;
        await Promise.all([...this.spaces.keys()].map(s => this.drop(s)));
        conn.disconnect();
        resolve();
      };
      process.once('SIGINT', () => void stop());
      process.once('SIGTERM', () => void stop());
    });
  }

  // Follow one space: clone its projects into <dir>/<space> if this folder
  // lacks them, then autosync them all.
  private async start(space: string) {
    if (this.spaces.has(space) || this.stopping) return;
    this.spaces.set(space, 'starting');
    try {
      const { conn } = await connectTo(this.o.server, this.o.db, this.o.token, { reconnect: true });
      const dir = path.join(this.o.dir, space);
      let found = findManifest(dir);
      if (!found || found.dir !== dir) {
        fs.mkdirSync(dir, { recursive: true });
        const manifest = { hub: this.o.server, space, projects: [] as string[] };
        for (const p of await projectsIn(conn, space)) {
          if (!fs.existsSync(path.join(dir, p.name))) await cloneProject(this.o.server, space, p.name, path.join(dir, p.name), p.defaultBranch, this.env);
          manifest.projects.push(p.name);
        }
        writeManifest(dir, manifest);
        found = { dir, manifest };
      }
      const sync = new SpaceSync({
        conn,
        dir,
        manifest: found.manifest,
        server: this.o.server,
        mode: 'auto',
        intervalMs: this.o.intervalMs,
        agent: this.o.agent,
        restart: `spacehub agent run ${this.o.agent}`,
        log: line => this.o.log(`${space}/${line}`),
        env: this.env,
        author: this.o.agent,
      });
      const beat = () => conn.reducers.watchHub({ space, mode: 'agent', host: this.o.host }).catch(err => this.o.log(`${space}: could not show presence: ${errorMessage(err)}`));
      await beat();
      const running = { conn, sync, beat: setInterval(beat, HEARTBEAT_MS) };
      this.spaces.set(space, running);
      this.o.log(`${space}: following (${found.manifest.projects.length} projects)`);
      void sync.run().then(paused => {
        if (paused) this.o.log(`${space}: every project is paused; resolve them and restart`);
      });
    } catch (err) {
      this.spaces.delete(space);
      this.o.log(`${space}: ${errorMessage(err)}`);
    }
  }

  private async drop(space: string) {
    const running = this.spaces.get(space);
    this.spaces.delete(space);
    if (!running || running === 'starting') return;
    clearInterval(running.beat);
    await running.sync.stop();
    running.conn.disconnect();
    if (!this.stopping) this.o.log(`${space}: no longer connected; stopped following it (the folder stays)`);
  }
}
