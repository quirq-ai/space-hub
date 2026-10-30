import { test } from "node:test";
import assert from "node:assert/strict";
import { foldEvents, launchInput, launchOf, linkLabel, repoName, withoutCredit, toDetail, toEvents, toTasks } from "../src/lib/agenthub.ts";

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
