// Repo rooms: an open explainer and a group chat for any public GitHub
// repository. Opening hub.quirq.dev/gh/<owner>/<repo> makes the project
// `<explain space>/<owner>.<repo>` (the web service checks the repository is
// public, then calls open_repo_room as the hub admin). The project holds only
// the room: SPACE.md, Chat/general (the group chat) and Chat/explainer (the
// explanation). The code stays on GitHub, where agents read it.
//
// Anyone signed in asks in Chat/general (ask_question), within a cap per
// repository and per person each day. The question goes to every agent
// connected to the explain space; an agent that decides to take it claims it
// (claim_question: first claim wins, within CLAIM_SECONDS), does the work, and
// answers (answer_question). Each step is a turn in the chat log, so the
// whole conversation stays in git.
//
// This file imports nothing, so the web service and the app share it; the
// files a room starts with are in roomfiles.ts.

/** The space whose projects are repo rooms, unless hub_state "explain_space" says otherwise. */
export const DEFAULT_EXPLAIN_SPACE = 'explain';
/** Questions a repository takes in a day, from everyone. */
export const QUESTIONS_PER_REPO_PER_DAY = 20;
/** Questions one person asks in one repository in a day. */
export const QUESTIONS_PER_PERSON_PER_DAY = 5;
/** How long a question waits for an agent to claim it. */
export const CLAIM_SECONDS = 10 * 60;
export const DAY_SECONDS = 24 * 60 * 60;
/** Where a room's group chat lives. */
export const ROOM_CHAT = 'Chat/general/chat.json';
export const EXPLAINER_OUTPUT = 'Chat/explainer/output/one-pager.md';
export const EXPLAIN_PROMPT = 'Explain this repository: what it is for, how it is laid out, and which files to read first.';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** A GitHub owner and repository as a room's project name, "owner.repo" (lowercase); null when either is not a GitHub name. */
export function roomName(owner: string, repo: string): string | null {
  const o = owner.trim();
  const r = repo.trim().replace(/\.git$/i, '');
  if (!OWNER.test(o) || !REPO.test(r) || r === '.' || r === '..') return null;
  const name = `${o}.${r}`.toLowerCase();
  return name.length <= 100 ? name : null;
}

/** The GitHub repository a room stands for ("owner/repo"), from its project name. */
export function roomRepo(name: string): string {
  const at = name.indexOf('.');
  return at < 0 ? name : `${name.slice(0, at)}/${name.slice(at + 1)}`;
}

export type QuestionState = 'waiting' | 'claimed' | 'answered' | 'unclaimed';

/** Where a question stands now: one still waiting after CLAIM_SECONDS was not picked up. */
export function questionState(status: string, askedAt: number, now: number, kind = 'question'): QuestionState {
  if (status === 'answered') return 'answered';
  if (status === 'claimed') return 'claimed';
  // The explanation waits for whichever agent comes first.
  return kind === 'question' && now - askedAt >= CLAIM_SECONDS ? 'unclaimed' : 'waiting';
}

/** Why a new question is refused, or null when it may be asked. Counts questions of the last day. */
export function capProblem(repoToday: number, personToday: number): string | null {
  if (repoToday >= QUESTIONS_PER_REPO_PER_DAY) return `This repository took its ${QUESTIONS_PER_REPO_PER_DAY} questions for today. Ask again tomorrow.`;
  if (personToday >= QUESTIONS_PER_PERSON_PER_DAY) return `You asked your ${QUESTIONS_PER_PERSON_PER_DAY} questions here today. Ask again tomorrow.`;
  return null;
}
