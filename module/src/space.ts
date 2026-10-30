// SPACE.md: what a project is for, at its root. Its goal, the outcomes that
// show the goal is met (a Markdown task list), who owns it, the rules and
// routines everyone (people and agents) follows, and, on a template, when to
// start from it. The app shows it above everything else, so a space opens on
// its goal and how far along it is, and cards show the same in one line.
//
// Templates are projects too: one whose SPACE.md has a "## Template"
// section, or the built-in goal space (spacetemplate.ts). Starting from one
// copies its files into a new project as one first commit, with the new
// goal and owner filled in (create_project_from_template in index.ts).
import { hashObject, serializeTree, type NewObject } from './chat';

export const SPACE_FILE = 'SPACE.md';
/** A template this many files or bytes big is refused: it is copied inside one transaction. */
export const MAX_TEMPLATE_FILES = 2000;
export const MAX_TEMPLATE_BYTES = 16 * 1024 * 1024;
/** Placeholders are filled in Markdown files up to this size. */
const FILL_BYTES = 256 * 1024;

export interface Outcome {
  text: string;
  done: boolean;
  /** Who answers for it: a trailing "@name", "(@name)", or a dash and a name. */
  owner: string;
}

export interface SpaceGoal {
  title: string;
  goal: string;
  due: string;
  outcomes: Outcome[];
  owners: string[];
  rules: string[];
  routines: string[];
  /** When to start from this project, if it is a template. */
  template: string | null;
}

const SECTIONS = ['goal', 'due', 'outcomes', 'owners', 'rules', 'routines', 'template'] as const;
type Section = (typeof SECTIONS)[number];

/** Inline Markdown as plain text: links keep their label, code and bold marks go. */
function plain(text: string) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ITEM = /^(?:[-*+]|\d+\.)\s+(.*)$/;
const TASK = /^\[( |x|X)\]\s+(.*)$/;
const OWNER = /(?:\s*\(@([A-Za-z0-9._-]+)\)|\s+[\u2014\u2013-]\s+@?([A-Za-z0-9._-]+)|\s+@([A-Za-z0-9._-]+))\s*$/;

function outcomeOf(item: string): Outcome {
  const task = TASK.exec(item);
  let text = plain(task ? task[2] : item);
  const owner = OWNER.exec(text);
  if (owner && owner.index > 0) text = text.slice(0, owner.index).trim();
  return { text, done: !!task && task[1].toLowerCase() === 'x', owner: owner && owner.index > 0 ? (owner[1] ?? owner[2] ?? owner[3]).toLowerCase() : '' };
}

/** Read a SPACE.md. Sections it does not know are left to the file. */
export function parseSpace(markdown: string): SpaceGoal {
  const out: SpaceGoal = { title: '', goal: '', due: '', outcomes: [], owners: [], rules: [], routines: [], template: null };
  const text: Partial<Record<Section, string[]>> = {};
  const items: Partial<Record<Section, string[]>> = {};
  let section: Section | undefined;
  let fence = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence || /^<!--.*-->$/.test(line)) continue;
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      if (heading[1].length === 1 && !out.title) out.title = plain(heading[2]).slice(0, 120);
      if (heading[1].length <= 2) {
        const name = heading[2].toLowerCase().trim() as Section;
        section = heading[1].length === 2 && SECTIONS.includes(name) ? name : undefined;
        if (section === 'template') out.template ??= '';
      }
      continue;
    }
    if (!section || !line) continue;
    const item = ITEM.exec(line);
    if (item) (items[section] ??= []).push(item[1]);
    else if (items[section]?.length && /^\s{2,}/.test(raw)) items[section]![items[section]!.length - 1] += ' ' + line;
    else (text[section] ??= []).push(line);
  }
  const paragraph = (name: Section, max: number) => plain((text[name] ?? items[name] ?? []).join(' ')).slice(0, max);
  out.goal = paragraph('goal', 500);
  out.due = paragraph('due', 40);
  out.outcomes = (items.outcomes ?? []).map(outcomeOf).filter(outcome => outcome.text).slice(0, 50);
  const names = [...(items.owners ?? []), ...(text.owners ?? []).flatMap(line => line.split(','))];
  out.owners = [...new Set(names.map(name => plain(name).replace(/^@/, '').split(/\s/)[0].toLowerCase()).filter(name => /^[a-z0-9._-]+$/.test(name)))].slice(0, 20);
  out.rules = (items.rules ?? text.rules ?? []).map(plain).filter(Boolean).slice(0, 30);
  out.routines = (items.routines ?? text.routines ?? []).map(plain).filter(Boolean).slice(0, 30);
  if (out.template !== null) out.template = paragraph('template', 300);
  return out;
}

/** How far along: outcomes done out of all of them. */
export function progressOf(goal: SpaceGoal) {
  return { done: goal.outcomes.filter(outcome => outcome.done).length, total: goal.outcomes.length };
}

/**
 * Replace one "## <name>" section's body (null drops the section). A section
 * that is not there is added at the end. Fenced code is not mistaken for
 * headings.
 */
export function setSection(markdown: string, name: string, body: string | null): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let fence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const heading = /^(#{1,2})\s+(.*?)\s*#*$/.exec(line);
    if (!heading) continue;
    if (start >= 0) { end = i; break; }
    if (heading[1].length === 2 && heading[2].toLowerCase().trim() === name.toLowerCase()) start = i;
  }
  if (start < 0) {
    if (body === null) return markdown;
    return `${markdown.replace(/\s*$/, '')}\n\n## ${name}\n\n${body.trim()}\n`;
  }
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const middle = body === null ? [] : [lines[start], '', body.trim(), ''];
  return [...before, ...middle, ...after].join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

export interface Fill {
  space: string;
  project: string;
  goal: string;
  owner: string;
  /** YYYY-MM-DD. */
  date: string;
}

/** A file of a template: its bytes and git mode. */
export interface TemplateFile {
  mode: string;
  data: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const NO_GOAL = 'Write the goal of this space in one sentence.';

/** Fill the placeholders; in JSON, as string content, so the file stays valid. */
function fillText(text: string, fill: Fill, json: boolean) {
  const values: Record<string, string> = { space: fill.space, project: fill.project, goal: fill.goal || NO_GOAL, owner: fill.owner, date: fill.date };
  return text.replace(/\{\{\s*(space|project|goal|owner|date)\s*\}\}/g, (_, key: string) => (json ? JSON.stringify(values[key]).slice(1, -1) : values[key]));
}

/**
 * A template's files as the new project's: placeholders ({{space}},
 * {{project}}, {{goal}}, {{owner}}, {{date}}) filled in Markdown and JSON
 * files, and
 * SPACE.md made the new space's: its goal, its creator as owner, every
 * outcome open again, and no "## Template" section (a space started from a
 * template is not one itself). A template without SPACE.md gets one.
 */
export function instantiate(files: Map<string, TemplateFile>, fill: Fill): Map<string, TemplateFile> {
  const out = new Map<string, TemplateFile>();
  for (const [path, file] of files) {
    if (!/\.(md|markdown|json)$/i.test(path) || file.data.length > FILL_BYTES) { out.set(path, file); continue; }
    let text: string;
    try {
      text = decoder.decode(file.data);
    } catch {
      out.set(path, file);
      continue;
    }
    out.set(path, { mode: file.mode, data: encoder.encode(fillText(text, fill, /\.json$/i.test(path))) });
  }
  const current = out.get(SPACE_FILE);
  let space = current ? decoder.decode(current.data) : `# ${fill.project}\n`;
  space = setSection(space, 'Template', null);
  if (fill.goal || !current) space = setSection(space, 'Goal', fill.goal || NO_GOAL);
  space = setSection(space, 'Owners', `- ${fill.owner}`);
  space = space.replace(/^(\s*(?:[-*+]|\d+\.)\s+)\[[xX]\]/gm, '$1[ ]');
  out.set(SPACE_FILE, { mode: current?.mode ?? '100644', data: encoder.encode(space) });
  return out;
}

/** The git objects of one commit holding exactly `files`, with no parent. */
export function commitFiles(files: Map<string, TemplateFile>, author: string, now: number, message: string): { commit: string; objects: NewObject[] } {
  const objects: NewObject[] = [];
  const seen = new Set<string>();
  const add = (kind: string, data: Uint8Array) => {
    const oid = hashObject(kind, data);
    if (!seen.has(oid)) { seen.add(oid); objects.push({ oid, kind, data }); }
    return oid;
  };
  type Folder = { files: Map<string, TemplateFile>; folders: Map<string, Folder> };
  const root: Folder = { files: new Map(), folders: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let at = root;
    for (const part of parts.slice(0, -1)) {
      if (!at.folders.has(part)) at.folders.set(part, { files: new Map(), folders: new Map() });
      at = at.folders.get(part)!;
    }
    at.files.set(parts[parts.length - 1], file);
  }
  const write = (folder: Folder): string => add('tree', serializeTree([
    ...[...folder.files].map(([name, file]) => ({ mode: file.mode, name, oid: add('blob', file.data) })),
    ...[...folder.folders].map(([name, inner]) => ({ mode: '40000', name, oid: write(inner) })),
  ]));
  const tree = write(root);
  const who = `${author.replace(/[<>\n]/g, '')} <${author.replace(/[<>\n\s]/g, '')}@spacehub> ${Math.floor(now)} +0000`;
  const commit = add('commit', encoder.encode(`tree ${tree}\nauthor ${who}\ncommitter ${who}\n\n${message}\n`));
  return { commit, objects };
}

/** Text files given as strings (the built-in template), as template files. */
export function textFiles(files: Record<string, string>): Map<string, TemplateFile> {
  return new Map(Object.entries(files).map(([path, text]) => [path, { mode: '100644', data: encoder.encode(text) }]));
}
