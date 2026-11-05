// A repo room's chat: a question's state now, and how many questions are left today (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionsLeft, stateNow } from '../src/lib/rooms.ts';

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
