import { test } from "node:test";
import assert from "node:assert/strict";
import { channelCards, channelConversation, channelOf, field, intro, listsChannels, readmeSections, snippet } from "../src/lib/channels.ts";

const entry = (path: string, kind: "file" | "directory", extra: Record<string, string> = {}) => ({ name: path.split("/").pop()!, path, kind, extension: kind === "file" ? path.split(".").pop()! : "", size: 1, modifiedAt: "2026-10-29T00:00:00Z", ...extra });

test("README sections by heading, ignoring headings in code", () => {
  const sections = readmeSections("# Title\n\n## Input\n\nBuild it.\n\n```\n## not a heading\n```\n\n## Output format\n\nWebsite\n\n## Status\n\n- Done\n");
  assert.equal(sections.input, "Build it.\n\n```\n## not a heading\n```");
  assert.equal(field(sections, "output format"), "Website");
  assert.equal(field(sections, "status"), "Done");
  assert.equal(field(sections, "owner"), "");
});

test("a channel is a README with Input or Output format, beside a conversation", () => {
  const entries = [entry("Chat/a/README.md", "file"), entry("Chat/a/notes.json", "file"), entry("Chat/a/chat.json", "file"), entry("Chat/a/inputs", "directory")];
  assert.equal(channelConversation(entries, "## Input\n\nx")?.name, "chat.json");
  assert.equal(channelConversation(entries, "# Just a folder\n\nNotes."), undefined);
  assert.equal(channelConversation(entries.filter(e => e.extension !== "json"), "## Input\n\nx"), undefined);
  assert.equal(channelConversation(entries, undefined), undefined);
});

test("channels sort open before done, newest message first, with kinds and unread", () => {
  const entries = [entry("Chat/euler", "directory", { outputFormat: "One pager" }), entry("Chat/old", "directory", { status: "Done" }), entry("Chat/hello", "directory"), entry("Chat/suraj", "directory"), entry("Chat/inbox.md", "file")];
  assert.ok(listsChannels(entries));
  const cards = channelCards(entries, {
    agents: ["euler"], people: ["Suraj"], me: "suraj",
    last: { "Chat/hello": { role: "user", author: "gates", content: "hi", time: "2026-10-29T10:00:00Z" }, "Chat/euler": { role: "assistant", author: "euler", content: "ok", time: "2026-10-29T09:00:00Z" }, "Chat/suraj": { role: "user", author: "suraj", content: "me", time: "2026-10-29T11:00:00Z" } },
    seen: { "Chat/hello": "2026-10-29T09:30:00Z", "Chat/euler": "2026-10-29T09:30:00Z", "Chat/suraj": "2026-10-29T09:30:00Z" },
  });
  assert.deepEqual(cards.map(card => [card.entry.name, card.kind, card.unread, card.done]), [
    ["suraj", "person", false, false], ["hello", "channel", true, false], ["euler", "agent", false, false], ["old", "channel", false, true],
  ]);
});

test("the channel a path is in, and a one-line snippet", () => {
  assert.equal(channelOf("Chat", "Chat/a/inputs/b.md"), "Chat/a");
  assert.equal(channelOf("Chat", "Chat"), undefined);
  assert.equal(channelOf("Chat", "Vision/a.md"), undefined);
  assert.equal(snippet("**Done.** See [the PR](https://x).\n\n- one"), "Done. See the PR. - one");
  assert.equal(snippet("a".repeat(10), 5), "aaaa…");
  assert.equal(snippet("Fix the login bug\n\n<!-- agenthub:task=t_1 -->"), "Fix the login bug");
});

test("a README's intro is its first paragraph, as one line", () => {
  assert.equal(intro("# Chat\n\nChat is organized in channels.\nEach one is a workstream.\n\n## Input\n\nx"), "Chat is organized in channels. Each one is a workstream.");
  assert.equal(intro("# Only a title\n\n## Input\n\n- a list"), "");
});
