// Chat turns saved from the app: one JSON line per turn appended to
// `<conversation>.log.jsonl` beside a conversation file, committed to the
// project's default branch. This is the format open-chat's hub backend
// writes, so either can read the other's chats. The reducer (append_chat
// in index.ts) runs it as one transaction, so two writers cannot race.
import { Sha1, objectHeader } from './sha1';
import { ApiError, MAX_TEXT_BYTES, isDirectoryMode, isFileMode, parseCommit, parseTree, relativePath, type TreeEntry } from './workspace';

export const MAX_TURNS = 2;
export const MAX_CONTENT = 4000;
const ID = /^[A-Za-z0-9-]{1,64}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export interface TurnIn {
  id: string;
  role: string;
  content: string;
  links: { label: string; path: string }[];
}

export interface NewObject {
  oid: string;
  kind: string;
  data: Uint8Array;
}

export function hashObject(kind: string, data: Uint8Array) {
  return new Sha1().update(objectHeader(kind, data.length)).update(data).hex();
}

function fromHex(oid: string) {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(oid.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Git orders entries bytewise, comparing a folder's name as if it ended in "/". */
export function serializeTree(entries: TreeEntry[]): Uint8Array {
  const key = (entry: TreeEntry) => encoder.encode(entry.name + (isDirectoryMode(entry.mode) ? '/' : ''));
  const sorted = [...entries].sort((a, b) => compareBytes(key(a), key(b)));
  const parts = sorted.map(entry => [encoder.encode(`${isDirectoryMode(entry.mode) ? '40000' : entry.mode} ${entry.name}\0`), fromHex(entry.oid)]).flat();
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function chatLogPath(conversation: string) {
  return /\.json$/i.test(conversation) ? conversation.replace(/\.json$/i, '.log.jsonl') : null;
}

function isConversation(data: unknown) {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  return object(data) && data.type === 'conversation' && Array.isArray(data.messages)
    && data.messages.every(message => object(message) && typeof message.content === 'string' && ['user', 'assistant', 'system'].includes(String(message.role)));
}

export function checkTurns(turns: TurnIn[]) {
  if (turns.length < 1 || turns.length > MAX_TURNS) throw new ApiError(`Send 1 to ${MAX_TURNS} messages at a time.`, 400);
  for (const turn of turns) {
    if (!ID.test(turn.id)) throw new ApiError('Each message needs an id of letters, digits and hyphens.', 400);
    if (turn.role !== 'user' && turn.role !== 'assistant') throw new ApiError('A message is from the user or the assistant.', 400);
    if (!turn.content.trim() || turn.content.length > MAX_CONTENT) throw new ApiError(`A message has 1 to ${MAX_CONTENT} characters.`, 400);
    if (turn.links.length > 10 || turn.links.some(link => link.label.length > 200 || link.path.length > 1024)) throw new ApiError('Too many or too long links.', 400);
  }
}

export interface AppendInput {
  /** The project's current default-branch commit. */
  head: string;
  conversation: string;
  turns: TurnIn[];
  /** Who saves: their name is the commit author and the author of user turns. */
  author: string;
  /** Seconds since the epoch. */
  now: number;
  read: (oid: string) => { kind: string; data: Uint8Array } | null;
}

/** Build the blob, trees and commit that append the turns; nothing is written here. */
export function appendTurns(input: AppendInput): { commit: string; objects: NewObject[]; log: string; subject: string } {
  checkTurns(input.turns);
  const conversation = relativePath(input.conversation);
  const log = chatLogPath(conversation);
  if (!log) throw new ApiError("Open a conversation's .json file to save a chat.", 400);
  if (!input.head) throw new ApiError('This project has no commits yet.', 400);
  const read = (oid: string, kind: string) => {
    const object = input.read(oid);
    if (!object || object.kind !== kind) throw new ApiError(`The hub is missing a ${kind}.`, 500);
    return object.data;
  };
  const tree = (oid: string) => (oid ? parseTree(read(oid, 'tree')) : []);
  const find = (root: string, path: string) => {
    let entries = tree(root);
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entry = entries.find(candidate => candidate.name === parts[i]);
      if (!entry || i === parts.length - 1) return entry;
      if (!isDirectoryMode(entry.mode)) return undefined;
      entries = tree(entry.oid);
    }
  };
  const root = parseCommit(read(input.head, 'commit')).tree;
  const file = find(root, conversation);
  if (!file) throw new ApiError('The requested file or folder was not found.', 404);
  if (!isFileMode(file.mode)) throw new ApiError("Open a conversation's .json file to save a chat.", 400);
  let data: unknown;
  try {
    data = JSON.parse(decoder.decode(read(file.oid, 'blob')));
  } catch {
    data = undefined;
  }
  if (!isConversation(data)) throw new ApiError('Only conversation files can take new messages.', 400);

  const existing = find(root, log);
  if (existing && !isFileMode(existing.mode)) throw new ApiError(`${log} is not a file a chat can be saved to.`, 409);
  const before = existing ? decoder.decode(read(existing.oid, 'blob')) : '';
  const time = new Date(input.now * 1000).toISOString();
  const lines = input.turns
    .map(turn => JSON.stringify({ id: turn.id, role: turn.role, author: turn.role === 'user' ? input.author : 'quirqy', content: turn.content, ...(turn.links.length ? { links: turn.links } : {}), time }) + '\n')
    .join('');
  const content = encoder.encode(before + (before && !before.endsWith('\n') ? '\n' : '') + lines);
  if (content.length > MAX_TEXT_BYTES) throw new ApiError('This chat log reached the 2 MB limit. Start a new conversation file.', 413);

  const objects: NewObject[] = [];
  const add = (kind: string, data: Uint8Array) => {
    const oid = hashObject(kind, data);
    objects.push({ oid, kind, data });
    return oid;
  };
  const blob = add('blob', content);
  const replace = (treeOid: string, parts: string[]): string => {
    const entries = tree(treeOid);
    const [name, ...rest] = parts;
    const current = entries.find(entry => entry.name === name);
    if (rest.length && current && !isDirectoryMode(current.mode)) throw new ApiError(`${name} is not a folder.`, 409);
    const entry: TreeEntry = rest.length
      ? { mode: '40000', name, oid: replace(current && isDirectoryMode(current.mode) ? current.oid : '', rest) }
      : { mode: current?.mode ?? '100644', name, oid: blob };
    return add('tree', serializeTree([...entries.filter(other => other.name !== name), entry]));
  };
  const newRoot = replace(root, log.split('/'));
  const who = `${input.author.replace(/[<>\n]/g, '')} <${input.author.replace(/[<>\n\s]/g, '')}@spacehub> ${Math.floor(input.now)} +0000`;
  const subject = `chat: ${input.turns.length === 1 ? '1 message' : `${input.turns.length} messages`} in ${log}`;
  const commit = add('commit', encoder.encode(`tree ${newRoot}\nparent ${input.head}\nauthor ${who}\ncommitter ${who}\n\n${subject}\n\nSaved from the hub's app.\n`));
  return { commit, objects, log, subject };
}

