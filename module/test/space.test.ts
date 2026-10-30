// SPACE.md goals and starting projects from templates (space.ts), in
// SpacetimeDB's in-process module harness: npm test.
import { describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { readObject, type Db } from '../src/store';
import { hashObject, serializeTree } from '../src/chat';
import { instantiate, parseSpace, setSection, textFiles } from '../src/space';
import { parseCommit, parseTree, renderApi, workspace, type Meta, type Snapshot, type Template } from '../src/workspace';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const LAUNCH = `# Launch the site

## Goal

Ship the new site by **December 1**, with sign-ups working.

## Due

2026-12-01

## Outcomes

- [x] Copy approved \u2014 @suraj
- [ ] Site live on [quirq.ai](https://quirq.ai) (@euler)
- [ ] 100 sign-ups
- [ ] Works on v1-beta browsers

## Owners

- @Suraj
- euler

## Rules

- Reply in place.
- One output per channel.

## Routines

- Every run: pull, reply, push.

\`\`\`
## Template
not a heading inside a fence
\`\`\`
`;

describe('SPACE.md', () => {
  it('reads the goal, the outcomes with their owners, owners, rules and routines', () => {
    const goal = parseSpace(LAUNCH);
    expect(goal).toMatchObject({ title: 'Launch the site', goal: 'Ship the new site by December 1, with sign-ups working.', due: '2026-12-01', owners: ['suraj', 'euler'], rules: ['Reply in place.', 'One output per channel.'], routines: ['Every run: pull, reply, push.'], template: null });
    expect(goal.outcomes).toEqual([
      { text: 'Copy approved', done: true, owner: 'suraj' },
      { text: 'Site live on quirq.ai', done: false, owner: 'euler' },
      { text: '100 sign-ups', done: false, owner: '' },
      { text: 'Works on v1-beta browsers', done: false, owner: '' },
    ]);
    expect(parseSpace('# T\n\n## Template\n\nFor launches.\n').template).toBe('For launches.');
    expect(parseSpace('# T\n\n## Owners\n\nsuraj, @euler\n').owners).toEqual(['suraj', 'euler']);
  });

  it('replaces, adds and drops sections, leaving fences alone', () => {
    const replaced = setSection(LAUNCH, 'Goal', 'A new goal.');
    expect(parseSpace(replaced).goal).toBe('A new goal.');
    expect(parseSpace(replaced).outcomes).toHaveLength(4);
    expect(setSection('# T\n', 'Goal', 'Added.')).toBe('# T\n\n## Goal\n\nAdded.\n');
    const dropped = setSection('# T\n\n## Template\n\nFor launches.\n\n## Rules\n\n- One.\n', 'Template', null);
    expect(dropped).toBe('# T\n\n## Rules\n\n- One.\n');
    expect(setSection(LAUNCH, 'Template', null)).toContain('not a heading inside a fence');
  });

  it("makes a template's files the new space's", () => {
    const files = textFiles({
      'SPACE.md': '# {{project}}\n\n## Goal\n\nOld goal.\n\n## Outcomes\n\n- [x] Done once\n\n## Owners\n\n- someone\n\n## Template\n\nFor launches.\n',
      'README.md': 'In {{space}}/{{project}}, since {{date}}: {{ goal }}',
      'Chat/general/chat.json': '{"type":"conversation","messages":[{"role":"assistant","content":"Goal: {{goal}}"}]}',
      'code.ts': 'const x = "{{goal}}";',
    });
    const out = instantiate(files, { space: 'acme', project: 'site', goal: 'Ship "it"', owner: 'bob', date: '2026-10-30' });
    const text = (path: string) => decoder.decode(out.get(path)!.data);
    const space = parseSpace(text('SPACE.md'));
    expect(space).toMatchObject({ title: 'site', goal: 'Ship "it"', owners: ['bob'], template: null, outcomes: [{ text: 'Done once', done: false, owner: '' }] });
    expect(text('README.md')).toBe('In acme/site, since 2026-10-30: Ship "it"');
    expect(JSON.parse(text('Chat/general/chat.json')).messages[0].content).toBe('Goal: Ship "it"');
    expect(text('code.ts')).toBe('const x = "{{goal}}";');
    expect(parseSpace(decoder.decode(instantiate(textFiles({ 'README.md': 'x' }), { space: 'a', project: 'p', goal: '', owner: 'bob', date: '' }).get('SPACE.md')!.data))).toMatchObject({ title: 'p', owners: ['bob'] });
  });
});

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const alice = as('alice');
  const bob = as('bob');
  call(alice, mod.registerUser, { username: 'alice' });
  call(bob, mod.registerUser, { username: 'bob' });
  call(alice, mod.createOrg, { name: 'quirq', description: 'our team' });
  const db = h.db as unknown as Db;
  const push = (project: string, files: Record<string, string>) => {
    const objects: { oid: string; kind: string; data: Uint8Array }[] = [];
    const add = (kind: string, data: Uint8Array) => { const oid = hashObject(kind, data); objects.push({ oid, kind, data }); return oid; };
    const tree = (inner: Record<string, string>): string => {
      const folders = new Map<string, Record<string, string>>();
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, content] of Object.entries(inner)) {
        const [head, ...rest] = name.split('/');
        if (rest.length) folders.set(head, { ...folders.get(head), [rest.join('/')]: content });
        else entries.push({ mode: '100644', name, oid: add('blob', encoder.encode(content)) });
      }
      for (const [name, files] of folders) entries.push({ mode: '40000', name, oid: tree(files) });
      return add('tree', serializeTree(entries));
    };
    const who = 'seed <seed@example.com> 1800000000 +0000';
    const commit = add('commit', encoder.encode(`tree ${tree(files)}\nauthor ${who}\ncommitter ${who}\n\nseed\n`));
    call(alice, mod.putObjects, { project, objects });
    call(alice, mod.updateRef, { project, name: 'refs/heads/main', oldOid: '', newOid: commit, force: false });
  };
  const view = (query: Record<string, string>) => workspace(db, { query: new Map(Object.entries(query)), viewer: null, now: 1_800_000_100 }) as { snapshot: Snapshot; meta: Meta };
  const files = (fullName: string) => {
    const project = db.project.fullName.find(fullName)!;
    const head = db.gitRef.key.find(`${project.id}:refs/heads/main`)!.oid;
    const out: Record<string, string> = {};
    const walk = (oid: string, base: string) => {
      for (const entry of parseTree(readObject(db, project.id, oid)!.data)) {
        const path = base ? `${base}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out[path] = decoder.decode(readObject(db, project.id, entry.oid)!.data);
      }
    };
    walk(parseCommit(readObject(db, project.id, head)!.data).tree, '');
    return { out, head, project };
  };
  const templates = () => (JSON.parse(renderApi(db, { query: new Map([['templates', '']]), viewer: null, now: 0 }).body) as { templates: Template[] }).templates;
  return { h, db, call, alice, bob, push, view, files, templates };
}

describe('templates', () => {
  it('starts a goal space from the built-in template, as one first commit by its creator', () => {
    const { call, alice, view, files } = hub();
    call(alice, mod.createProjectFromTemplate, { space: 'quirq', name: 'launch', description: 'the launch', template: '', goal: 'Ship the new site by December 1.' });
    const { out, head, project } = files('quirq/launch');
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['SPACE.md', 'README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'Chat/general/README.md', 'Chat/general/chat.json', 'Vision/README.md']));
    expect(Object.values(out).join('\n')).not.toContain('{{');
    expect(out['Chat/general/README.md']).toContain('Plan how to reach the goal: Ship the new site by December 1.');
    expect(JSON.parse(out['Chat/general/chat.json']).type).toBe('conversation');
    expect(project.defaultBranch).toBe('main');

    const meta = view({ space: 'quirq', project: 'launch' }).meta as Extract<Meta, { level: 'project' }>;
    expect(meta.head).toMatchObject({ oid: head, author: 'alice', subject: 'Start quirq/launch from the goal space template' });
    expect(meta.goal).toMatchObject({ title: 'launch', goal: 'Ship the new site by December 1.', owners: ['alice'], template: null });
    expect(meta.goal!.outcomes[0]).toMatchObject({ done: false, owner: 'alice' });
    expect(meta.bytes).toBeGreaterThan(0);

    const card = view({ space: 'quirq' }).snapshot.directory.entries.find(entry => entry.name === 'launch')!;
    expect(card).toMatchObject({ goal: 'Ship the new site by December 1.', progress: { done: 0, total: 2 } });
    expect(card.template).toBeUndefined();
  });

  it('lists projects marked as templates and copies one, leaving the template as it was', () => {
    const { call, alice, bob, push, files, templates, view } = hub();
    call(alice, mod.createProject, { space: 'quirq', name: 'playbook', description: 'how we launch' });
    push('quirq/playbook', {
      'SPACE.md': '# Launch playbook\n\n## Goal\n\n{{goal}}\n\n## Outcomes\n\n- [x] Brief written\n- [ ] Launched\n\n## Owners\n\n- alice\n\n## Template\n\nFor any launch: brief, channels, checklist.\n',
      'Chat/brief/README.md': '# Brief\n\n## Owner\n\n{{owner}}\n',
      'notes.txt': 'kept as is {{goal}}',
    });
    call(alice, mod.createProject, { space: 'quirq', name: 'plain', description: '' });
    push('quirq/plain', { 'README.md': '# not a template' });

    expect(templates().map(t => [t.id, t.title, t.builtin])).toEqual([['goal', 'Goal space', true], ['quirq/playbook', 'Launch playbook', false]]);
    expect(templates()[1]).toMatchObject({ about: 'For any launch: brief, channels, checklist.', outcomes: 2 });
    expect(view({ space: 'quirq' }).snapshot.directory.entries.find(entry => entry.name === 'playbook')).toMatchObject({ template: true, progress: { done: 1, total: 2 } });

    // Anyone may start from a template, in a space they belong to.
    call(bob, mod.createProjectFromTemplate, { space: 'bob', name: 'q4-launch', description: '', template: 'quirq/playbook', goal: 'Launch Q4.' });
    const { out } = files('bob/q4-launch');
    expect(Object.keys(out).sort()).toEqual(['Chat/brief/README.md', 'SPACE.md', 'notes.txt']);
    expect(out['Chat/brief/README.md']).toContain('bob');
    expect(out['notes.txt']).toBe('kept as is {{goal}}');
    expect(parseSpace(out['SPACE.md'])).toMatchObject({ title: 'Launch playbook', goal: 'Launch Q4.', owners: ['bob'], template: null });
    expect(parseSpace(out['SPACE.md']).outcomes.every(o => !o.done)).toBe(true);
    expect(parseSpace(files('quirq/playbook').out['SPACE.md']).template).toBe('For any launch: brief, channels, checklist.');

    expect(() => call(bob, mod.createProjectFromTemplate, { space: 'bob', name: 'x', description: '', template: 'quirq/plain', goal: '' })).toThrow(/not a template/);
    expect(() => call(bob, mod.createProjectFromTemplate, { space: 'bob', name: 'y', description: '', template: 'quirq/nope', goal: '' })).toThrow(/no template/);
    expect(() => call(bob, mod.createProjectFromTemplate, { space: 'quirq', name: 'z', description: '', template: '', goal: '' })).toThrow(/permission denied/);
    expect(() => call(bob, mod.createProjectFromTemplate, { space: 'bob', name: 'q4-launch', description: '', template: '', goal: '' })).toThrow(/already exists/);
  });
});
