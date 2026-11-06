// Repo rooms (explain.ts): opened by the hub, questions from anyone signed
// in within the caps, claimed and answered by connected agents. Run in
// SpacetimeDB's in-process module harness: npm test.
import { describe, expect, it } from 'vitest';
import { ConnectionId, TimeDuration } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { CLAIM_SECONDS, QUESTIONS_PER_PERSON_PER_DAY, QUESTIONS_PER_REPO_PER_DAY, questionState, roomName, roomRepo } from '../src/explain';
import { parseCommit, parseTree, renderApi, parseQuery } from '../src/workspace';
import { readObject } from '../src/store';

let nextConnection = 1n;
function as(subject: string) {
  const payload = JSON.stringify({ iss: 'https://test.example', sub: subject, aud: ['spacetimedb'], iat: 0 });
  return TestAuth.fromJwtPayload(payload, new ConnectionId(nextConnection++));
}

const ROOM = 'explain/octo.hello-world';

function hub() {
  const h = createModuleTestHarness(spacetimedb, mod);
  const call = (auth: TestAuth, reducer: (ctx: any, args: any) => void, args: object = {}) => h.withReducerTx(auth, ctx => reducer(ctx, args));
  const admin = as('admin');
  const alice = as('alice');
  const bob = as('bob');
  const scout = as('scout');
  const rival = as('rival');
  call(admin, mod.claimAdmin);
  call(alice, mod.registerUser, { username: 'alice' });
  call(bob, mod.registerUser, { username: 'bob' });
  call(alice, mod.createOrg, { name: 'explain', description: 'Open repo rooms' });
  for (const [name, auth] of [['scout', scout], ['rival', rival]] as const) {
    const hex = h.withReducerTx(auth, ctx => ctx.sender.toHexString());
    call(alice, mod.createAgent, { name, parent: 'alice', identity: hex, token: `${name}-token`, description: '' });
    call(alice, mod.connectAgent, { agent: name, space: 'explain' });
  }
  const open = () => call(admin, mod.openRepoRoom, { owner: 'Octo', repo: 'Hello-World', description: 'My first repo', openedBy: 'bob' });
  const log = () => {
    const sp = h.db.project.fullName.find(ROOM)!;
    const head = [...h.db.gitRef.projectId.filter(sp.id)][0].oid;
    let tree = parseTree(readObject(h.db as any, sp.id, parseCommit(readObject(h.db as any, sp.id, head)!.data).tree)!.data);
    for (const part of ['Chat', 'general']) tree = parseTree(readObject(h.db as any, sp.id, tree.find(e => e.name === part)!.oid)!.data);
    const file = tree.find(e => e.name === 'chat.log.jsonl');
    const text = file ? new TextDecoder().decode(readObject(h.db as any, sp.id, file.oid)!.data) : '';
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; role: string; author: string; content: string });
  };
  const seconds = (n: number) => TimeDuration.fromMillis(n * 1000);
  return { h, call, admin, alice, bob, scout, rival, open, log, seconds };
}

describe('room names', () => {
  it('turn a GitHub repository into one project name and back', () => {
    expect(roomName('Octo', 'Hello-World')).toBe('octo.hello-world');
    expect(roomName('octo', 'site.github.io.git')).toBe('octo.site.github.io');
    expect(roomRepo('octo.site.github.io')).toBe('octo/site.github.io');
    expect(roomName('-bad', 'x')).toBeNull();
    expect(roomName('ok', '..')).toBeNull();
    expect(roomName('ok', 'a/b')).toBeNull();
  });

  it('mark a question nobody claimed in time, except the explanation', () => {
    expect(questionState('open', 0, CLAIM_SECONDS - 1)).toBe('waiting');
    expect(questionState('open', 0, CLAIM_SECONDS)).toBe('unclaimed');
    expect(questionState('open', 0, CLAIM_SECONDS * 10, 'explain')).toBe('waiting');
    expect(questionState('claimed', 0, CLAIM_SECONDS * 10)).toBe('claimed');
  });
});

describe('repo rooms', () => {
  it('are opened by the hub only, once, with the explanation asked first', () => {
    const { h, call, alice, open, log } = hub();
    expect(() => call(alice, mod.openRepoRoom, { owner: 'octo', repo: 'hello-world', description: '', openedBy: 'alice' })).toThrow(/permission denied/);
    open();
    open(); // again is a no-op
    const sp = h.db.project.fullName.find(ROOM)!;
    expect(sp.description).toBe('My first repo');
    expect(log()).toEqual([expect.objectContaining({ id: 'explain', role: 'user', author: 'bob' })]);
    expect([...h.db.question.projectId.filter(sp.id)]).toEqual([expect.objectContaining({ id: 'explain', kind: 'explain', asker: 'bob', status: 'open' })]);
  });

  it('need the explain org', () => {
    const { h, call, admin } = hub();
    h.withReducerTx(admin, ctx => ctx.db.hubState.insert({ key: 'explain_space', value: 'nowhere' }));
    expect(() => call(admin, mod.openRepoRoom, { owner: 'octo', repo: 'x', description: '', openedBy: 'bob' })).toThrow(/make the org "nowhere" first/);
  });

  it('take questions from anyone signed in, claimed and answered by one connected agent', () => {
    const { h, call, bob, scout, rival, alice, open, log } = hub();
    open();
    // bob is no member of explain, and still asks.
    call(bob, mod.askQuestion, { project: ROOM, id: 'q1', content: 'Where does the server start?' });
    expect(() => call(bob, mod.askQuestion, { project: ROOM, id: 'q1', content: 'again' })).toThrow(/already asked/);
    expect(() => call(bob, mod.askQuestion, { project: 'alice/notes', id: 'q2', content: 'x' })).toThrow(/not found|not a repo room/);
    expect(() => call(alice, mod.claimQuestion, { project: ROOM, id: 'q1' })).toThrow(/agents claim/);
    call(scout, mod.claimQuestion, { project: ROOM, id: 'q1' });
    expect(() => call(rival, mod.claimQuestion, { project: ROOM, id: 'q1' })).toThrow(/scout already took/);
    expect(() => call(rival, mod.answerQuestion, { project: ROOM, id: 'q1', content: 'mine', links: [] })).toThrow(/claim the question/);
    call(scout, mod.answerQuestion, { project: ROOM, id: 'q1', content: 'In src/main.ts.', links: [{ label: 'main.ts', path: 'https://github.com/octo/hello-world/blob/main/src/main.ts' }] });
    expect(() => call(scout, mod.answerQuestion, { project: ROOM, id: 'q1', content: 'twice', links: [] })).toThrow(/already answered/);
    expect(log().map(t => `${t.role} ${t.author} ${t.id}`)).toEqual(['user bob explain', 'user bob q1', 'assistant scout q1-claim', 'assistant scout q1-answer']);
    const sp = h.db.project.fullName.find(ROOM)!;
    expect(h.db.question.key.find(`${sp.id}:q1`)).toMatchObject({ status: 'answered', agent: 'scout' });
  });

  it('let only agents connected to the explain space claim', () => {
    const { call, alice, rival, open } = hub();
    open();
    call(alice, mod.disconnectAgent, { agent: 'rival', space: 'explain' });
    expect(() => call(rival, mod.claimQuestion, { project: ROOM, id: 'explain' })).toThrow(/not connected/);
  });

  it('stop claims after the wait, but not for the explanation', () => {
    const { h, call, bob, scout, open, seconds } = hub();
    open();
    call(bob, mod.askQuestion, { project: ROOM, id: 'late', content: 'Anyone?' });
    h.clock.advance(seconds(CLAIM_SECONDS));
    expect(() => call(scout, mod.claimQuestion, { project: ROOM, id: 'late' })).toThrow(/not picked up/);
    call(scout, mod.claimQuestion, { project: ROOM, id: 'explain' });
  });

  it('cap questions per person and per repository each day', () => {
    const { h, call, bob, alice, open, seconds } = hub();
    open();
    for (let i = 0; i < QUESTIONS_PER_PERSON_PER_DAY; i++) call(bob, mod.askQuestion, { project: ROOM, id: `b${i}`, content: `question ${i}` });
    expect(() => call(bob, mod.askQuestion, { project: ROOM, id: 'bx', content: 'one more' })).toThrow(/You asked your 5 questions/);
    // More people fill the repository's cap.
    let asked = QUESTIONS_PER_PERSON_PER_DAY;
    for (let p = 0; asked < QUESTIONS_PER_REPO_PER_DAY; p++) {
      const who = as(`person${p}`);
      call(who, mod.registerUser, { username: `person${p}` });
      for (let i = 0; i < QUESTIONS_PER_PERSON_PER_DAY && asked < QUESTIONS_PER_REPO_PER_DAY; i++, asked++) call(who, mod.askQuestion, { project: ROOM, id: `p${p}-${i}`, content: 'q' });
    }
    expect(() => call(alice, mod.askQuestion, { project: ROOM, id: 'a1', content: 'mine' })).toThrow(/took its 20 questions/);
    h.clock.advance(seconds(24 * 60 * 60));
    call(alice, mod.askQuestion, { project: ROOM, id: 'a1', content: 'next day' });
  });

  it('show the room in the project view: repository, caps, agents and questions', () => {
    const { h, call, bob, scout, open } = hub();
    open();
    call(bob, mod.askQuestion, { project: ROOM, id: 'q1', content: 'How do I run it?' });
    call(scout, mod.claimQuestion, { project: ROOM, id: 'q1' });
    const now = Number(h.withReducerTx(bob, ctx => ctx.timestamp.microsSinceUnixEpoch / 1_000_000n));
    const body = JSON.parse(renderApi(h.db as any, { query: parseQuery('space=explain&project=octo.hello-world'), viewer: 'bob', now } as any).body);
    expect(body.meta.room).toMatchObject({ repo: 'octo/hello-world', github: 'https://github.com/octo/hello-world', perRepo: 20, perPerson: 5, askedToday: 1, mineToday: 1, agents: ['rival', 'scout'] });
    expect(body.meta.room.questions.map((q: { id: string; state: string }) => `${q.id} ${q.state}`)).toEqual(['explain waiting', 'q1 claimed']);
    expect(body.meta.goal.goal).toMatch(/octo\/hello-world/i);
  });

  it('mark the explain space, and only it, as the one whose chat opens rooms', () => {
    const { h, open } = hub();
    open();
    const metaOf = (space: string) => JSON.parse(renderApi(h.db as any, { query: parseQuery(`space=${space}`), viewer: 'bob', now: 0 } as any).body).meta;
    expect(metaOf('explain').rooms).toBe(true);
    expect(metaOf('bob').rooms).toBeUndefined();
  });
});
