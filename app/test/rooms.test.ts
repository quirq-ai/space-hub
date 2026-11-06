// A repo room's chat: a question's state now, and how many questions are left today (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainReply, questionsLeft, repoOfGithubUrl, stateNow } from '../src/lib/rooms.ts';

const room = { repo: 'octo/x', github: 'https://github.com/octo/x', perRepo: 20, perPerson: 5, claimSeconds: 600, askedToday: 3, mineToday: 1, agents: [], questions: [] };

test('a waiting question is not picked up once its wait is over; the explanation keeps waiting', () => {
  const askedAt = '2026-11-05T12:00:00.000Z';
  const at = (minutes: number) => Date.parse(askedAt) + minutes * 60_000;
  const q = { id: 'q', kind: 'question', asker: 'bob', state: 'waiting' as const, agent: '', askedAt };
  assert.equal(stateNow(q, 600, at(9)), 'waiting');
  assert.equal(stateNow(q, 600, at(10)), 'unclaimed');
  assert.equal(stateNow({ ...q, kind: 'explain' }, 600, at(60)), 'waiting');
  assert.equal(stateNow({ ...q, state: 'answered', agent: 'euler' }, 600, at(60)), 'answered');
});

test('questions left: the smaller of the person\'s and the repository\'s, with why none', () => {
  assert.deepEqual(questionsLeft(room), { left: 4, why: '' });
  assert.match(questionsLeft({ ...room, mineToday: 5 }).why, /You asked your 5/);
  assert.match(questionsLeft({ ...room, askedToday: 20 }).why, /took its 20/);
});

test('the explain chat takes a GitHub repository URL and nothing else', () => {
  for (const url of ['https://github.com/octo/hello-world', 'http://github.com/octo/hello-world', 'github.com/octo/hello-world', 'https://www.github.com/octo/hello-world', '  https://github.com/octo/hello-world\n', 'https://GitHub.com/octo/hello-world/', 'https://github.com/octo/hello-world.git', 'https://github.com/octo/hello-world/tree/main/src?x=1#y']) {
    assert.equal(repoOfGithubUrl(url), 'octo/hello-world', url);
  }
  for (const text of ['', 'octo/hello-world', 'hello', 'https://github.com/octo', 'https://github.com/', 'https://gitlab.com/octo/hello-world', 'https://github.com.evil.example/octo/hello-world', 'https://evil.example/github.com/octo/hello-world', 'https://gist.github.com/octo/hello-world', 'git@github.com:octo/hello-world.git', 'look at https://github.com/octo/hello-world', 'https://github.com/octo/hello-world please', 'https://github.com/octo/..', 'javascript:alert(1)//github.com/octo/x']) {
    assert.equal(repoOfGithubUrl(text), null, text);
  }
});

test('the explain chat replies with the explanation once it is in, else where it stands', () => {
  const question = (state: 'waiting' | 'claimed' | 'answered', agent = '') => ({ id: 'explain', kind: 'explain', asker: 'bob', state, agent, askedAt: '' });
  const withQuestion = (q: ReturnType<typeof question>) => ({ ...room, questions: [q] });
  assert.deepEqual(explainReply(undefined, []), { state: 'waiting', agent: '' });
  assert.deepEqual(explainReply(withQuestion(question('waiting')), []), { state: 'waiting', agent: '' });
  assert.deepEqual(explainReply(withQuestion(question('claimed', 'euler')), [{ id: 'explain-claim', role: 'assistant', content: 'euler is on it.', author: 'euler' }]), { state: 'claimed', agent: 'euler' });
  const answer = { id: 'explain-answer', role: 'assistant' as const, content: 'It is a tool.', author: 'euler' };
  assert.deepEqual(explainReply(withQuestion(question('answered', 'euler')), [answer]), { state: 'answered', agent: 'euler', answer });
});
