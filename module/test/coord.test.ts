// Repositories that coordinate others (a DEPS file, AGENTS.md, work items)
// and content workspaces made of channels (folders with a README), as the
// app's workspace API shows them: npm test.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import type { Db } from '../src/store';
import { hashObject, serializeTree } from '../src/chat';
import { githubRepo, parseDeps, type Dep } from '../src/deps';
import { codeView, summarize, workspace, type Meta, type Snapshot } from '../src/workspace';

let nextConnection = 1000n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const encoder = new TextEncoder();
type Obj = { oid: string; kind: string; data: Uint8Array };

function build(files: Record<string, string>, objects: Obj[]): string {
  const folders = new Map<string, Record<string, string>>();
  const entries: { mode: string; name: string; oid: string }[] = [];
  const add = (kind: string, data: Uint8Array) => {
    const oid = hashObject(kind, data);
    objects.push({ oid, kind, data });
    return oid;
  };
  for (const [name, content] of Object.entries(files)) {
    const [head, ...rest] = name.split('/');
    if (rest.length) folders.set(head, { ...folders.get(head), [rest.join('/')]: content });
    else entries.push({ mode: '100644', name, oid: add('blob', encoder.encode(content)) });
  }
  for (const [name, inner] of folders) entries.push({ mode: '40000', name, oid: build(inner, objects) });
  return add('tree', serializeTree(entries));
}

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const alice = as('alice');
  call(alice, mod.registerUser, { username: 'alice' });
  call(alice, mod.createOrg, { name: 'quirq', description: 'our team' });
  let clock = 1_800_000_000;
  const heads = new Map<string, string>();
  /** Commit `files` on top of `branch` of `project` (or on `parent`), and return the commit. */
  const push = (project: string, files: Record<string, string>, branch = 'main', parent?: string) => {
    const objects: Obj[] = [];
    const tree = build(files, objects);
    const key = `${project}:${branch}`;
    const base = parent ?? heads.get(key) ?? '';
    const who = `alice <alice@example.com> ${clock++} +0000`;
    const data = encoder.encode(`tree ${tree}\n${base ? `parent ${base}\n` : ''}author ${who}\ncommitter ${who}\n\nchange ${clock}\n`);
    const oid = hashObject('commit', data);
    call(alice, mod.putObjects, { project, objects: [...objects, { oid, kind: 'commit', data }] });
    call(alice, mod.updateRef, { project, name: `refs/heads/${branch}`, oldOid: heads.get(key) ?? '', newOid: oid, force: true });
    heads.set(key, oid);
    return oid;
  };
  const db = h.db as unknown as Db;
  const query = (q: Record<string, string>) => ({ query: new Map(Object.entries(q)), viewer: 'alice', now: 1_800_000_100 });
  const view = (q: Record<string, string>) => workspace(db, query(q)) as { snapshot: Snapshot; meta: Extract<Meta, { level: 'project' }> };
  const deps = (project: string) => {
    const [space, name] = project.split('/');
    return codeView(db, query({ space, project: name, view: 'deps' })) as { found: boolean; valid: boolean; deps: Dep[] };
  };
  return { call, alice, push, view, deps };
}

const CHANNEL = `# Ship the launch

## Input

Agree on the [launch date](Vision/plan.md) and the \`three\` announcements.

## Output format

One pager

## Owner

euler

## Status

Done
`;

describe('folders with a README', () => {
  it('reads a title, a first line and the channel sections', () => {
    expect(summarize(CHANNEL)).toEqual({ title: 'Ship the launch', line: 'Agree on the launch date and the three announcements.', status: 'Done', owner: 'euler', outputFormat: 'One pager' });
    expect(summarize('```\n# not a title\n```\n\n- first point\n')).toMatchObject({ title: '', line: 'first point' });
    expect(summarize('# Only a title\n').line).toBe('');
  });

  it('shows each folder by its README, and the README under the listing', () => {
    const { call, alice, push, view } = hub();
    call(alice, mod.createProject, { space: 'quirq', name: 'quirq', description: '' });
    push('quirq/quirq', {
      'README.md': '# quirq\n\nThe workspace.\n',
      'CLAUDE.md': '# CLAUDE.md\n\nRead CONTRIBUTING.md.\n',
      'CONTRIBUTING.md': '# Keeping quirq organized\n',
      'Chat/README.md': '# Chat\n\nChat is organized in channels.\n',
      'Chat/launch/README.md': CHANNEL,
      'Chat/launch/chat.json': '{"type":"conversation","title":"Launch","messages":[{"role":"user","content":"hi"}]}',
      'Chat/hello-world/README.md': '# Hello world\n\n## Input\n\nSay hello.\n',
      'Chat/plain/notes.txt': 'no readme here\n',
    });
    const root = view({ space: 'quirq', project: 'quirq' }).snapshot;
    expect(root.directory.entries.find(entry => entry.name === 'Chat')).toMatchObject({ detail: 'Chat is organized in channels.' });
    // The README first, then the guides a visitor or an agent reads; CLAUDE.md usually points at them.
    expect(root.directory.docs?.map(doc => doc.path)).toEqual(['README.md', 'CONTRIBUTING.md']);

    const chat = view({ space: 'quirq', project: 'quirq', path: 'Chat' }).snapshot;
    const rows = Object.fromEntries(chat.directory.entries.map(entry => [entry.name, entry]));
    expect(rows.launch).toMatchObject({ detail: 'Ship the launch · Agree on the launch date and the three announcements.', status: 'Done', owner: 'euler', outputFormat: 'One pager' });
    // A title that only restates the folder's name is left out.
    expect(rows['hello-world'].detail).toBe('Say hello.');
    expect(rows.plain.detail).toBeUndefined();
    expect(chat.directory.docs).toEqual([{ name: 'README.md', path: 'Chat/README.md', content: '# Chat\n\nChat is organized in channels.\n' }]);

    // An open file shows the file, not its folder's documents.
    const file = view({ space: 'quirq', project: 'quirq', path: 'Chat/launch/chat.json' }).snapshot;
    expect(file.directory.docs).toBeUndefined();
    expect(file.directory.entries.find(entry => entry.name === 'README.md')).toBeTruthy();
  });
});

describe('a DEPS file', () => {
  it('parses pins in file order and spells GitHub URLs one way', () => {
    expect(parseDeps('{"b":{"url":"https://github.com/a/b","commit-hash":"ABC"},"a":{"url":"x"},"bad":3}')).toEqual([
      { path: 'b', url: 'https://github.com/a/b', pin: 'abc' },
      { path: 'a', url: 'x', pin: '' },
    ]);
    expect(parseDeps('deps = {}')).toBeNull();
    expect(parseDeps('[]')).toBeNull();
    for (const url of ['https://github.com/Quirq-AI/Space-Hub.git', 'git@github.com:quirq-ai/space-hub.git', 'https://github.com/quirq-ai/space-hub/']) {
      expect(githubRepo(url)).toBe('https://github.com/quirq-ai/space-hub');
    }
    expect(githubRepo('https://gitlab.com/a/b')).toBe('');
  });

  it('links each pin to the hub project that holds it and says whether it is current', () => {
    const { call, alice, push, view, deps } = hub();
    for (const name of ['coord', 'api', 'web', 'docs', 'lib']) call(alice, mod.createProject, { space: 'quirq', name, description: '' });
    // api and web came from GitHub; lib is linked by its hub URL; docs has no import.
    call(alice, mod.startImport, { project: 'quirq/api', source: 'https://github.com/quirq-ai/api' });
    call(alice, mod.startImport, { project: 'quirq/web', source: 'https://github.com/quirq-ai/web' });
    const api1 = push('quirq/api', { 'README.md': '# api\n' });
    push('quirq/api', { 'README.md': '# api, 2\n' });
    const api3 = push('quirq/api', { 'README.md': '# api, 3\n' });
    const web = push('quirq/web', { 'README.md': '# web\n' });
    const side = push('quirq/web', { 'README.md': '# web, a side branch\n' }, 'side', web);
    const lib = push('quirq/lib', { 'README.md': '# lib\n' });
    const pins = {
      api: { url: 'https://github.com/quirq-ai/api.git', 'commit-hash': api1 },
      'api-latest': { url: 'git@github.com:quirq-ai/api.git', 'commit-hash': api3 },
      web: { url: 'https://github.com/quirq-ai/web', 'commit-hash': side },
      gone: { url: 'https://github.com/quirq-ai/web', 'commit-hash': 'f'.repeat(40) },
      lib: { url: 'quirq://hub.quirq.dev/quirq/lib', 'commit-hash': lib },
      elsewhere: { url: 'https://github.com/someone/else', 'commit-hash': 'a'.repeat(40) },
      short: { url: 'https://github.com/quirq-ai/api', 'commit-hash': 'abc123' },
    };
    push('quirq/coord', { DEPS: JSON.stringify(pins, null, 2) + '\n', 'AGENTS.md': '# AGENTS.md\n', 'WORK_ITEMS.md': '# Work items\n' });

    const root = view({ space: 'quirq', project: 'coord' });
    expect(root.meta.deps).toBe(7);
    expect(root.snapshot.directory.docs?.map(doc => doc.name)).toEqual(['AGENTS.md', 'WORK_ITEMS.md']);
    const file = view({ space: 'quirq', project: 'coord', path: 'DEPS' }).snapshot.file!;
    expect(file.format).toBe('json');
    expect(Object.keys(file.data as object)).toEqual(Object.keys(pins));

    const result = deps('quirq/coord');
    expect(result).toMatchObject({ found: true, valid: true });
    const by = Object.fromEntries(result.deps.map(dep => [dep.path, dep]));
    expect(result.deps.map(dep => dep.path)).toEqual(Object.keys(pins));
    expect(by.api).toMatchObject({ project: 'quirq/api', status: 'behind', behind: 2, github: 'https://github.com/quirq-ai/api', defaultBranch: 'main' });
    expect(by.api.pinned?.oid).toBe(api1);
    expect(by.api.head?.oid).toBe(api3);
    expect(by['api-latest']).toMatchObject({ project: 'quirq/api', status: 'current', behind: 0 });
    expect(by.web).toMatchObject({ project: 'quirq/web', status: 'elsewhere' });
    expect(by.gone).toMatchObject({ project: 'quirq/web', status: 'missing', pinned: null });
    expect(by.lib).toMatchObject({ project: 'quirq/lib', status: 'current', github: '' });
    expect(by.elsewhere).toMatchObject({ project: '', status: 'external', github: 'https://github.com/someone/else' });
    expect(by.short.status).toBe('invalid');
  });

  it('counts nothing without a DEPS file, and shows one that is not JSON as text', () => {
    const { call, alice, push, view, deps } = hub();
    call(alice, mod.createProject, { space: 'quirq', name: 'chromium', description: '' });
    push('quirq/chromium', { DEPS: "vars = {}\ndeps = { 'src/v8': Var('v8') }\n" });
    expect(view({ space: 'quirq', project: 'chromium' }).meta.deps).toBe(0);
    expect(view({ space: 'quirq', project: 'chromium', path: 'DEPS' }).snapshot.file).toMatchObject({ format: 'text', content: expect.stringContaining('vars') });
    expect(deps('quirq/chromium')).toMatchObject({ found: true, valid: false, deps: [] });
    push('quirq/chromium', { 'README.md': '# no pins\n' });
    expect(deps('quirq/chromium')).toMatchObject({ found: false, deps: [] });
  });

  it('puts the commit of each push in the activity feed', () => {
    const { call, alice, push, view } = hub();
    call(alice, mod.createProject, { space: 'quirq', name: 'quirq', description: '' });
    const oid = push('quirq/quirq', { 'README.md': '# quirq\n' });
    expect(view({ space: 'quirq', project: 'quirq' }).meta.activity.find(item => item.kind.startsWith('ref_'))?.oid).toBe(oid);
  });
});
