import { test } from "node:test";
import assert from "node:assert/strict";
import { cardActions, cardHeadline, connectOutcome, foldEvents, unknownWorkerNote, launchInput, launchNote, launchOf, linkLabel, repoName, runnerLabel, stateNote, toWorkerDetail, webLinksOnly, withoutCredit, toDetail, toEvents, toTasks, type RunnerInfo } from "../src/lib/workers.ts";

test("tasks from a list or {tasks}, newest activity first", () => {
  const tasks = toTasks({ tasks: [
    { id: "a", title: "Old", status: "done", createdAt: "2026-10-29T10:00:00Z" },
    { id: "b", title: "", status: "running", created_at: "2026-10-29T09:00:00Z", updatedAt: "2026-10-29T12:00:00Z", repo: "quirq-ai/space-hub" },
    { title: "no id" },
  ] });
  assert.deepEqual(tasks.map(task => [task.id, task.title, task.repo]), [["b", "Untitled session", "quirq-ai/space-hub"], ["a", "Old", ""]]);
  assert.equal(toTasks([{ id: "x" }])[0].status, "running");
  assert.deepEqual(toTasks({ nope: 1 }), []);
});

test("a task's result keeps only https links", () => {
  const { task, result } = toDetail({ task: { id: "t", title: "T", status: "done" }, result: { summary: "Opened a PR", links: ["https://github.com/o/r/pull/3", { label: "Docs", url: "https://x.dev" }, "javascript:alert(1)"], error: "" } });
  assert.equal(task?.id, "t");
  assert.deepEqual(result.links, [{ label: "", url: "https://github.com/o/r/pull/3" }, { label: "Docs", url: "https://x.dev" }]);
  assert.equal(linkLabel("https://github.com/o/r/pull/3"), "o/r#3");
});

test("events page from `after`, dropping repeats", () => {
  assert.deepEqual(toEvents({ events: [{ seq: 3, kind: "note" }], next: 3 }, 2), { events: [{ seq: 3, kind: "note" }], next: 3 });
  assert.deepEqual(toEvents([{ seq: 1 }, { seq: 2 }, { seq: 5 }], 2), { events: [{ seq: 5 }], next: 5 });
  assert.deepEqual(toEvents({ events: [] }, 4), { events: [], next: 4 });
});

test("events fold into messages, one group of steps per stretch of work, links and notes", () => {
  const items = foldEvents([
    { seq: 1, kind: "user", text: "Fix it" },
    { seq: 2, kind: "env", state: "connected" },
    { seq: 3, kind: "thinking", text: "Reading the repo" },
    { seq: 4, kind: "command", id: "c1", command: "npm test" },
    { seq: 5, kind: "command_done", id: "c1", exitCode: 1, output: "1 failing\n" },
    { seq: 6, kind: "tool", id: "t1", server: "github", name: "create_pr", args: "{}" },
    { seq: 6, kind: "tool", id: "t1", server: "github", name: "create_pr", args: "{}" },
    { seq: 7, kind: "tool_done", id: "t1", ok: true, output: "ok" },
    { seq: 8, kind: "message", text: "Done: **PR opened**" },
    { seq: 9, kind: "link", url: "https://github.com/o/r/pull/1", label: "PR" },
    { seq: 10, kind: "link", url: "javascript:x" },
    { seq: 11, kind: "turn", state: "completed" },
    { seq: 12, kind: "mystery" },
  ]);
  assert.deepEqual(items.map(item => item.type), ["user", "note", "steps", "agent", "link", "note"]);
  const steps = items[2];
  assert.ok(steps.type === "steps");
  assert.equal(steps.open, false);
  assert.deepEqual(steps.steps.map(step => [step.kind, step.label, step.state, step.exit]), [["thinking", "Reading the repo", "ok", null], ["command", "npm test", "fail", 1], ["tool", "github · create_pr", "ok", null]]);
  assert.equal(steps.steps[1].output, "1 failing");
  assert.deepEqual(items.at(-1), { type: "note", key: "e11", text: "Done", tone: "done" });
});

test("work still going stays open", () => {
  const [steps] = foldEvents([{ seq: 1, kind: "command", id: "c", command: "ls" }]);
  assert.ok(steps.type === "steps" && steps.open && steps.steps[0].state === "run");
});

test("the credit line is not shown in the task", () => {
  assert.equal(withoutCredit("Fix it\n\n(Launched by suraj from quirq/quirq, Chat/a/chat.json.)"), "Fix it");
  assert.equal(withoutCredit("Fix it (Launched early)"), "Fix it (Launched early)");
});

test("a launch turn names its worker; other turns do not", () => {
  assert.deepEqual(launchOf("Fix the README\n\n<!-- agenthub:task=abc_1 -->"), { task: "abc_1", text: "Fix the README" });
  assert.equal(launchOf("Fix the README"), null);
  assert.equal(launchOf("<!-- agenthub:task=a b -->"), null);
});

test("launching from GitHub: a repository, or an issue or PR whose link joins the task", () => {
  assert.deepEqual(launchInput("Fix this", "https://github.com/quirq-ai/quirq/issues/7"), { text: "Fix this\n\nhttps://github.com/quirq-ai/quirq/issues/7", repo: "https://github.com/quirq-ai/quirq/issues/7" });
  assert.deepEqual(launchInput("Fix this ", "quirq-ai/quirq"), { text: "Fix this", repo: "quirq-ai/quirq" });
  assert.equal(repoName("https://github.com/quirq-ai/quirq/pull/3"), "quirq-ai/quirq");
  assert.equal(repoName("not a repo"), "");
});

// ---------------------------------------------------------------- runners and the worker card
const all = { followUp: true, stop: true, events: true, repo: true, connect: false };
const none = { followUp: false, stop: false, events: false, repo: false, connect: false };
const card = (status: string, extra: Record<string, unknown> = {}, caps = all) => toWorkerDetail({
  task: { id: "t1", title: "Fix", status }, result: { summary: "ok", links: [], error: null },
  launcher: "priya", mine: false, runner: { id: "r1", name: "Priya hub", kind: "Agents Hub", capabilities: caps }, ...extra,
});

test("a viewer only sees the steps, and only when the runner shares them", () => {
  assert.deepEqual(cardActions(card("running"), "arjun"), { steps: true, followUp: false, stop: false, tearDown: false });
  assert.deepEqual(cardActions(card("done"), "arjun"), { steps: true, followUp: false, stop: false, tearDown: false });
  assert.equal(cardActions(card("running", {}, none), "arjun").steps, false);
});

test("the launcher stops a running worker, and follows up or tears down an idle one, each by capability", () => {
  assert.deepEqual(cardActions(card("running"), "priya"), { steps: true, followUp: false, stop: true, tearDown: false });
  assert.deepEqual(cardActions(card("done"), "priya"), { steps: true, followUp: true, stop: false, tearDown: true });
  assert.deepEqual(cardActions(card("running", {}, none), "priya"), { steps: false, followUp: false, stop: false, tearDown: false });
  assert.deepEqual(cardActions(card("done", {}, none), "priya"), { steps: false, followUp: false, stop: false, tearDown: true });
  assert.deepEqual(cardActions(card("gone", { state: "gone" }), "priya"), { steps: false, followUp: false, stop: false, tearDown: false });
  assert.deepEqual(cardActions(card("done", { state: "disconnected" }), "priya"), { steps: false, followUp: false, stop: false, tearDown: false });
});

test("the headline says whose runner it is on", () => {
  assert.equal(cardHeadline(card("running"), "priya"), "on your Agents Hub");
  assert.equal(cardHeadline(card("running"), "arjun"), "on priya's Agents Hub");
});

test("a state note for each state, none when live", () => {
  assert.equal(stateNote(card("gone", { state: "gone" })), "Torn down · result kept");
  assert.equal(stateNote(card("done", { state: "disconnected" })), "priya's runner is not connected");
  assert.equal(stateNote(card("done", { state: "unreachable" })), "priya's runner did not answer");
  assert.equal(stateNote(card("done", { state: "disconnected" }), "priya"), "Your runner is not connected · connect it again in Settings");
  assert.equal(stateNote(card("done", { state: "unreachable" }), "priya"), "Your runner did not answer");
  assert.equal(stateNote(card("done", { state: "disconnected" }), "arjun"), "priya's runner is not connected");
  assert.equal(stateNote(card("done")), "");
});

test("a detail keeps only https links and drops unknown states", () => {
  const d = toWorkerDetail({ task: { id: "t", title: "T", status: "done" }, result: { links: ["https://github.com/o/r/pull/1", "javascript:x"] }, state: "weird", launcher: "priya" });
  assert.deepEqual(d.result.links.map(l => l.url), ["https://github.com/o/r/pull/1"]);
  assert.equal(d.state, "");
  assert.equal(d.runner, null);
});

test("the launch note names the runner a worker will run on", () => {
  const r = (id: string, name: string, isDefault: boolean): RunnerInfo => ({ id, name, kind: "Agents Hub", url: "https://x", isDefault, capabilities: all, connectedAt: "", checkedAt: "" });
  assert.equal(launchNote([]), "Connect a runner in Settings to launch workers");
  assert.equal(launchNote([r("a", "Mine", true)]), "Runs on Mine · Agents Hub");
  assert.equal(launchNote([r("a", "Mine", false), r("b", "Work", true)]), "Runs on Work · Agents Hub");
});

test("a runner is named once when its name is the start of its kind", () => {
  assert.equal(runnerLabel("Agents Hub", "Agents Hub · OpenAI"), "Agents Hub · OpenAI");
  assert.equal(runnerLabel("Krish's hub", "Agents Hub · OpenAI"), "Krish's hub · Agents Hub · OpenAI");
  assert.equal(runnerLabel("", "Agents Hub"), "Agents Hub");
  const r: RunnerInfo = { id: "a", name: "Agents Hub", kind: "Agents Hub · OpenAI", url: "https://x", isDefault: true, capabilities: all, connectedAt: "", checkedAt: "" };
  assert.equal(launchNote([r]), "Runs on Agents Hub · OpenAI");
});

test("links a viewer cannot open (sandbox files) become plain text; web links stay", () => {
  assert.equal(webLinksOnly("Saved in the [research brief](research/brief.md)."), "Saved in the research brief.");
  assert.equal(webLinksOnly("See [file](/workspace/work/a.md) and [x](sandbox:/a)"), "See file and x");
  assert.equal(webLinksOnly("Watch [Intro](https://youtu.be/zjkBMFhNj_g) now"), "Watch [Intro](https://youtu.be/zjkBMFhNj_g) now");
  assert.equal(webLinksOnly("An image ![chart](out/chart.png) here"), "An image chart here");
  assert.equal(webLinksOnly("Plain text, no links."), "Plain text, no links.");
});

test("the same note twice in a row shows once", () => {
  const items = foldEvents([
    { seq: 1, kind: "env", state: "connected" },
    { seq: 2, kind: "env", state: "connected" },
    { seq: 3, kind: "message", text: "hi" },
    { seq: 4, kind: "env", state: "connected" },
  ]);
  assert.deepEqual(items.map(i => i.type === "note" ? `note:${i.text}` : i.type), ["note:Sandbox connected.", "agent", "note:Sandbox connected."]);
});

test("back from Connect: a plain sentence for each outcome, nothing for anything else", () => {
  assert.deepEqual(connectOutcome("connected"), { ok: true, text: "Runner connected. You can launch workers on it now." });
  assert.equal(connectOutcome("denied")?.ok, false);
  assert.match(connectOutcome("denied")!.text, /cancelled/);
  assert.match(connectOutcome("expired")!.text, /press Connect again/);
  assert.match(connectOutcome("failed")!.text, /paste a token/);
  assert.match(connectOutcome("full")!.text, /Agent access/);
  // Connect Agents Hub's own: about XO, not the runner.
  assert.match(connectOutcome("xodenied")!.text, /allow access on XO/);
  assert.match(connectOutcome("xoexpired")!.text, /Connect Agents Hub again/);
  assert.match(connectOutcome("xofailed")!.text, /Connect Agents Hub/);
  for (const code of ["xodenied", "xoexpired", "xofailed"]) assert.doesNotMatch(connectOutcome(code)!.text, /runner|paste a token/);
  assert.equal(connectOutcome("<script>"), null);
  assert.equal(connectOutcome(null), null);
});

test("a card space-hub has no record of says why, without sounding like an error", () => {
  assert.equal(unknownWorkerNote(404, ""), "Launched on the hub’s old shared runner; its result is no longer available.");
  assert.equal(unknownWorkerNote(403, ""), "Only members of this space can follow its workers.");
  assert.equal(unknownWorkerNote(500, "boom"), "boom");
  assert.equal(unknownWorkerNote(0, ""), "");
});
