// Members-only and private projects over every route (scripts/leak-test.sh
// runs it through the hub's one public port, Caddy and all): each request in
// scripts/routes.ts LIST, as an anonymous browser, a signed-in stranger (a
// valid identity with no builder, and a forged display-name cookie) and a
// member.
//   off:     nobody is refused by the front door, and the anonymous browser
//            gets today's data where LIST says it does;
//   on:      the anonymous browser and the stranger get no project, file or
//            builder name anywhere; every route not open is refused (sign in,
//            or a 401); the member sees exactly what it saw with it off;
//   private: the project is private (members-only off). Also as an outsider:
//            a builder of the hub who may not read it, with a forged
//            display-name cookie naming the owner. Nobody but the member gets
//            its name, files or size anywhere (a hub listing counts no project
//            and no bytes), and every request that names it answers exactly
//            as the same request about a project that does not exist; the
//            member sees exactly what it saw with it public.
// Every request also carries the headers only the proxy may set, forged
// (among them a viewer naming the owner, and a made-up secret).
// It first fails when the code has a route LIST does not cover.
//   node --experimental-strip-types scripts/routeprobe.ts <base url> <off|on|private> <out.json> [<off.json to compare with>]
//   env: LEAK_MARKERS (comma-separated), LEAK_COMMIT, STRANGER_TOKEN, MEMBER_TOKEN,
//        and for private: LEAK_PROJECT_MARKERS (the project's own markers, its name first), OUTSIDER_TOKEN
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { LIST, unlisted, type Probe } from './routes.ts';

const [base, mode, out, compare] = process.argv.slice(2);
if (!base || (mode !== 'off' && mode !== 'on' && mode !== 'private') || !out) throw new Error('usage: routeprobe.ts <base url> <off|on|private> <out.json> [compare.json]');
if (mode === 'private' && !compare) throw new Error('private: give the results with the project public to compare with');
const root = path.resolve(import.meta.dirname, '..');
const env = (name: string) => process.env[name] ?? (() => { throw new Error(`set ${name}`); })();
const markers = env('LEAK_MARKERS').split(',').filter(Boolean);
const commit = env('LEAK_COMMIT');
const personas: Record<string, string> = {
  anonymous: '',
  stranger: `spacehub_session=${encodeURIComponent(env('STRANGER_TOKEN'))}; spacehub_user=alice`,
  member: `spacehub_session=${encodeURIComponent(env('MEMBER_TOKEN'))}; spacehub_user=alice`,
  ...(mode === 'private' ? { outsider: `spacehub_session=${encodeURIComponent(env('OUTSIDER_TOKEN'))}; spacehub_user=alice` } : {}),
};
// The private project's own markers (its name first), and a name no project
// has: a request about the one must answer as about the other.
const projectMarkers = mode === 'private' ? env('LEAK_PROJECT_MARKERS').split(',').filter(Boolean) : [];
const project = projectMarkers[0] ?? '';
const nosuch = 'nosuchproj';

interface Result { persona: string; key: string; method: string; path: string; status: number; denied: boolean; leaked: string[]; twin?: string }

const bad: string[] = [];
const check = (label: string, ok: boolean) => {
  if (!ok) bad.push(label);
};

function send(probe: Probe, cookie: string): Promise<{ status: number; location: string; denied: boolean; body: string }> {
  const target = new URL(base);
  const method = probe.method ?? 'GET';
  const body = method === 'POST' ? (probe.json === undefined ? '' : JSON.stringify(probe.json)) : '';
  const headers: Record<string, string> = {
    accept: probe.api ? 'application/json' : probe.stream ? 'text/event-stream' : 'text/html,application/xhtml+xml',
    origin: base,
    // Forged: only the proxy may set these.
    'x-forwarded-uri': '/-/login',
    'x-forwarded-method': 'GET',
    'x-spacehub-uri': '/-/login',
    'x-spacehub-viewer': 'alice',
    'x-spacehub-secret': 'f'.repeat(64),
    ...(cookie ? { cookie } : {}),
    ...(method === 'POST' ? { 'content-type': probe.json === undefined ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
  };
  if (process.env.LEAK_VERBOSE) process.stderr.write(`${method} ${probe.path}\n`);
  return new Promise((resolve, reject) => {
    // A stream is read for a moment; anything else must answer within 15 s.
    const deadline = setTimeout(() => req.destroy(new Error(`no answer in 15 s: ${method} ${probe.path}`)), 15_000);
    const req = http.request({ host: target.hostname, port: target.port, method, path: probe.path.replace('{commit}', commit), headers, agent: false }, res => {
      const parts: Buffer[] = [];
      const done = () => {
        clearTimeout(deadline);
        resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? ''), denied: !!res.headers['x-spacehub-members-only'], body: Buffer.concat(parts).toString('utf8') });
      };
      res.on('data', d => parts.push(d));
      res.on('end', done);
      res.on('close', done);
      if (probe.stream) setTimeout(() => res.destroy(), 2_500);
    });
    req.on('error', err => {
      clearTimeout(deadline);
      reject(err);
    });
    req.end(body);
  });
}

const { missing, stale } = unlisted(root);
for (const r of missing) check(`route ${r.key} (${r.where}) is not on the leak test's list: add it to scripts/routes.ts LIST`, false);
for (const k of stale) check(`LIST names ${k}, which the code no longer has`, false);

const results: Result[] = [];
for (const [persona, cookie] of Object.entries(personas)) {
  for (const [key, probes] of Object.entries(LIST)) {
    for (const probe of probes) {
      const method = probe.method ?? 'GET';
      const label = `${mode} ${persona} ${method} ${probe.path}`;
      let got;
      try {
        got = await send(probe, cookie);
      } catch (err) {
        check(`${label}: ${err instanceof Error ? err.message : err}`, false);
        continue;
      }
      // A redirect may repeat what the browser asked for; nothing else may name the hub's things.
      const asked = probe.path.replace('{commit}', commit);
      const leaked = markers.filter(m => !asked.includes(m) && (got.body.includes(m) || got.location.includes(m)));
      const result: Result = { persona, key, method, path: probe.path, status: got.status, denied: got.denied, leaked };
      results.push(result);
      if (mode === 'private') {
        check(`${label}: refused by the front door with members-only off (${got.status})`, !got.denied);
        if (persona === 'member') continue; // compared with the public run below
        const shown = projectMarkers.filter(m => !asked.includes(m) && (got.body.includes(m) || got.location.includes(m)));
        check(`${label}: shows the private project (${shown.join(', ')}; ${got.status})`, shown.length === 0);
        // Its size and count: a hub or space listing counts nothing (the project is the hub's only one).
        if (probe.api && method === 'GET' && got.status === 200 && /^\/-\/api\/view(?:\?space=alice)?$/.test(asked)) {
          const meta = (JSON.parse(got.body) as { meta?: { projects?: number; bytes?: number } }).meta;
          check(`${label}: counts ${meta?.projects} projects, ${meta?.bytes} bytes`, meta?.projects === 0 && meta?.bytes === 0);
        }
        // About it, exactly as about a project that does not exist.
        if (asked.includes(project)) {
          let twin;
          try {
            twin = await send({ ...probe, path: probe.path.replaceAll(project, nosuch) }, cookie);
          } catch (err) {
            check(`${label} (as ${nosuch}): ${err instanceof Error ? err.message : err}`, false);
            continue;
          }
          const same = (a: string) => a.replaceAll(project, nosuch);
          // A stream's content depends on timing: its answer is compared, not its events.
          const alike = twin.status === got.status && same(got.location) === twin.location && (probe.stream || same(got.body) === twin.body);
          result.twin = alike ? 'same' : `differs (${got.status} vs ${twin.status})`;
          check(`${label}: answers unlike a missing project (${got.status} ${got.location} vs ${twin.status} ${twin.location})`, alike);
        }
      } else if (mode === 'off') {
        check(`${label}: refused by the front door with members-only off (${got.status})`, !got.denied);
        if (persona === 'anonymous' && probe.shows) check(`${label}: shows no data with members-only off (today it does; ${got.status})`, leaked.length > 0);
      } else if (persona === 'member') {
        check(`${label}: a member is refused (${got.status})`, !got.denied);
        if (probe.shows) check(`${label}: a member sees no data (${got.status})`, leaked.length > 0);
      } else {
        check(`${label}: leaks ${leaked.join(', ')} (${got.status})`, leaked.length === 0);
        if (probe.open) check(`${label}: an open route is refused (${got.status})`, !got.denied);
        else {
          const page = !probe.api && !probe.stream && method === 'GET';
          const signIn = got.status === 303 && got.location.startsWith('/-/login?next=');
          check(`${label}: not refused (${got.status} ${got.location})`, got.denied && (page ? signIn : got.status === 401));
        }
      }
    }
  }
}

if (compare) {
  const before = JSON.parse(fs.readFileSync(compare, 'utf8')) as Result[];
  const key = (r: Result) => `${r.persona} ${r.method} ${r.path}`;
  const off = new Map(before.map(r => [key(r), r]));
  for (const r of results.filter(r => r.persona === 'member')) {
    const o = off.get(key(r));
    check(`member ${r.method} ${r.path}: ${o?.status}/${o?.leaked.length ? 'data' : 'none'} before, ${r.status}/${r.leaked.length ? 'data' : 'none'} ${mode}`, !!o && o.status === r.status && !!o.leaked.length === !!r.leaked.length);
  }
}

fs.writeFileSync(out, JSON.stringify(results, null, 1));
const counted = (p: string) => results.filter(r => r.persona === p).length;
const refused = results.filter(r => r.denied).length;
const twins = results.filter(r => r.twin).length;
const title = mode === 'private' ? 'private project' : `members-only ${mode}`;
console.log(`  ${bad.length ? 'FAIL' : 'ok  '} ${title}: ${Object.keys(LIST).length} routes, ${counted('anonymous')} requests each as ${Object.keys(personas).join(', ')}; ${refused} refused${mode === 'private' ? `; ${twins} answered as for a missing project` : ''}`);
for (const b of bad) console.log(`  FAIL ${b}`);
process.exit(bad.length ? 1 : 0);
