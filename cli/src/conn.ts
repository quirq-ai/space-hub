// One connection to the spacehub database plus small read helpers. Reads are
// short-lived subscriptions: subscribe, take what arrived, unsubscribe.
import { DbConnection, tables } from './module_bindings';
import type { Identity, RowTypedQuery } from 'spacetimedb';
import { loadConfig, saveToken } from './config';

export { tables };
export type Conn = DbConnection;

const debug = !!process.env.SPACEHUB_DEBUG;

// The SDK logs connection chatter through console.log/info. stdout belongs to
// git when we run as a remote helper, so route it to stderr (debug only).
export function quietSdkLogs() {
  const toStderr = (...args: unknown[]) => {
    if (debug) process.stderr.write(args.map(String).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

// Connect with an explicit token (or none, which creates a new identity).
// Long-lived connections pass `reconnect`: if the hub goes away after the
// connection opened, the SDK reconnects and replays the subscriptions.
export interface ConnectOptions {
  reconnect?: boolean;
}

export function connectTo(
  server: string,
  database: string,
  token?: string,
  options: ConnectOptions = {}
): Promise<{ conn: Conn; identity: Identity; token: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${server} (database "${database}")`)), 15_000);
    const builder = DbConnection.builder().withUri(server).withDatabaseName(database).withToken(token);
    if (options.reconnect) builder.withAutomaticReconnect();
    builder
      .onConnect((conn, identity, issued) => {
        clearTimeout(timer);
        resolve({ conn, identity, token: issued });
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to ${server} (database "${database}"): ${err?.message ?? err}`));
      })
      .build();
  });
}

// Connect as the identity saved for `server` (default: the configured one),
// creating and saving one on first use.
export async function connect(server?: string, options: ConnectOptions = {}): Promise<{ conn: Conn; identity: Identity; server: string; database: string }> {
  const cfg = loadConfig(server);
  const { conn, identity, token } = await connectTo(cfg.server, cfg.database, cfg.token, options);
  if (!cfg.token && !process.env.SPACEHUB_TOKEN) saveToken(cfg.server, token);
  return { conn, identity, server: cfg.server, database: cfg.database };
}

// Subscribe to `query`, run `read` once the rows are in the cache, then drop
// the subscription so the rows do not linger in memory.
export function snapshot<T>(conn: Conn, query: string | RowTypedQuery<any, any>, read: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        let value: T;
        try {
          value = read();
        } catch (err) {
          reject(err);
          return;
        }
        handle.unsubscribeThen(() => resolve(value));
      })
      .onError(ctx => reject(new Error(`query failed: ${(ctx as { event?: unknown }).event ?? 'unknown error'}`)))
      .subscribe(query);
  });
}

export function findSpace(conn: Conn, fullName: string) {
  return snapshot(conn, tables.space.where(s => s.fullName.eq(fullName)), () =>
    [...conn.db.space.iter()].find(s => s.fullName === fullName)
  );
}

export function listRefs(conn: Conn, spaceId: bigint) {
  return snapshot(conn, tables.gitRef.where(r => r.spaceId.eq(spaceId)), () =>
    [...conn.db.gitRef.iter()].filter(r => r.spaceId === spaceId).sort((a, b) => a.name.localeCompare(b.name))
  );
}

export function findUser(conn: Conn, identity: Identity) {
  return snapshot(conn, tables.user.where(u => u.identity.eq(identity)), () =>
    [...conn.db.user.iter()].find(u => u.identity.isEqual(identity))
  );
}

export function errorMessage(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error: /, '');
}
