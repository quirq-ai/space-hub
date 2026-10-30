import type { Entry } from "./types";

/**
 * Chat as channels, the way quirq lays it out: `Chat/<channel>/` holds a
 * README (its "## Input" and "## Output format"), a conversation `chat.json`
 * with the hub's `chat.log.jsonl` beside it, `inputs/`, `output/`, and
 * sub-channels one level down in the same shape. Agents and people get
 * channels named after them.
 */

/** A README's "## Heading" sections, by lowercased heading, each with its text trimmed. */
export function readmeSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | undefined;
  let fence = false;
  let lines: string[] = [];
  const close = () => { if (current !== undefined && !(current in sections)) sections[current] = lines.join("\n").trim(); };
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { close(); current = heading[1].toLowerCase(); lines = []; }
    else if (current !== undefined) lines.push(line);
  }
  close();
  return sections;
}

/** The first line of a section, for one-word fields such as Status, Owner, Agent or Worker. */
export function field(sections: Record<string, string>, name: string): string {
  return (sections[name] ?? "").split(/\r?\n/).map(line => line.replace(/^[-*]\s+/, "").replace(/[`*_]/g, "").trim()).find(Boolean) ?? "";
}

/** A channel's own folders; every other folder inside it is a sub-channel. */
export const CHANNEL_FOLDERS = new Set(["inputs", "output"]);

/** Done, Closed and Finished read as finished. */
export const isDone = (status: string | undefined) => /^(done|closed|finished)$/i.test(status ?? "");

/** A folder whose README declares an Input or an Output format, with a conversation beside it, is a channel. */
export function channelConversation(entries: Entry[], readme: string | undefined): Entry | undefined {
  if (readme === undefined) return;
  const sections = readmeSections(readme);
  if (!("input" in sections) && !("output format" in sections)) return;
  const conversations = entries.filter(entry => entry.kind === "file" && entry.extension === "json");
  return conversations.find(entry => entry.name === "chat.json") ?? conversations.find(entry => entry.name === "index.json") ?? conversations[0];
}

/** A folder lists channels when some of its folders carry channel labels from their READMEs. */
export function listsChannels(entries: Entry[]): boolean {
  return entries.some(entry => entry.kind === "directory" && !!entry.outputFormat);
}

export type ChannelKind = "channel" | "agent" | "person";
export type LastTurn = { author?: string; role: string; content: string; time?: string };
export type ChannelCard = { entry: Entry; kind: ChannelKind; done: boolean; last?: LastTurn; unread: boolean };

/**
 * The channels of a folder, newest conversation first: an agent's channel is
 * named after an agent of the space, a personal one after one of its people.
 * A channel is unread when someone else wrote in it after the viewer last
 * looked (`seen`, by channel path).
 */
export function channelCards(entries: Entry[], { agents, people, last, seen, me }: {
  agents: string[]; people: string[]; last: Record<string, LastTurn | undefined>; seen: Record<string, string>; me: string | null;
}): ChannelCard[] {
  const agentSet = new Set(agents.map(name => name.toLowerCase()));
  const peopleSet = new Set(people.map(name => name.toLowerCase()));
  return entries.filter(entry => entry.kind === "directory").map(entry => {
    const name = entry.name.toLowerCase();
    const turn = last[entry.path];
    const unread = !!turn?.time && !!seen[entry.path] && turn.time > seen[entry.path] && (!me || turn.author?.toLowerCase() !== me.toLowerCase());
    return { entry, kind: agentSet.has(name) ? "agent" : peopleSet.has(name) ? "person" : "channel", done: isDone(entry.status), last: turn, unread } satisfies ChannelCard;
  }).sort((a, b) => Number(a.done) - Number(b.done) || (b.last?.time ?? "").localeCompare(a.last?.time ?? "") || a.entry.name.localeCompare(b.entry.name));
}

/** The channel a path is in, under the channels folder `root`: `Chat/x/inputs/a.md` is in `Chat/x`. */
export function channelOf(root: string, path: string): string | undefined {
  if (!root || !path.startsWith(root + "/")) return;
  const name = path.slice(root.length + 1).split("/")[0];
  return name ? `${root}/${name}` : undefined;
}

/** One line of a message for a preview: Markdown marks and line breaks dropped. */
export function snippet(content: string, max = 120): string {
  const plain = content.replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_`~|]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
}

/** What a README says a folder is for: its first paragraph, as one line. */
export function intro(markdown: string, max = 240): string {
  const paragraph = markdown.replace(/```[\s\S]*?```/g, "").split(/\r?\n\s*\r?\n/).map(block => block.trim()).find(block => block && !/^(#|<!--|[-*|>] |\|)/.test(block));
  return paragraph ? snippet(paragraph, max) : "";
}
