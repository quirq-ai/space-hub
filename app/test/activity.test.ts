import { test } from "node:test";
import assert from "node:assert/strict";
import { dayOf, keepActivity, liveRows, mergeActivity } from "../src/lib/activity.ts";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
let nextId = 1;
const item = (kind: string, agent: string, id = String(nextId++)) => ({ id, at: at(2026, 11, 2), agent, kind, path: "quirq/quirq", subject: "refs/heads/main", text: "", count: 1, oid: "" });

test("day headings: today, yesterday, a weekday this week, else the date", () => {
  const now = new Date(2026, 10, 2, 9);
  assert.equal(dayOf(at(2026, 11, 2, 0), now), "Today");
  assert.equal(dayOf(at(2026, 11, 1, 23), now), "Yesterday");
  assert.equal(dayOf(at(2026, 10, 29), now), "Thursday, Oct 29");
  assert.equal(dayOf(at(2026, 10, 20), now), "Oct 20");
  assert.equal(dayOf(at(2025, 12, 31), now), "Dec 31, 2025");
  // A clock a little behind the server still says today.
  assert.equal(dayOf(at(2026, 11, 3, 0), now), "Today");
});

test("activity filters: split by who did it, a human or an agent, pushes included", () => {
  const agents = new Set(["euler"]);
  const rows = [item("ref_updated", "euler"), item("ref_created", "suraj"), item("agent_created", "suraj"), item("agent_registered", "yash"), item("project_created", "euler"), item("space_synced", "")];
  const shown = (filter: Parameters<typeof keepActivity>[0]) => rows.filter(row => keepActivity(filter, row, agents)).map(row => `${row.kind}:${row.agent}`);
  assert.equal(shown("all").length, rows.length);
  assert.deepEqual(shown("humans"), ["ref_created:suraj", "agent_created:suraj", "agent_registered:yash"]);
  assert.deepEqual(shown("agents"), ["ref_updated:euler", "project_created:euler"]);
  // Each row someone did is under exactly one of the two.
  assert.equal(shown("humans").length + shown("agents").length, rows.filter(row => row.agent).length);
});

test("who is here: one row each, agents first with their machine, the viewed project left out", () => {
  const here = [
    { agent: "yash", mode: "autosync", project: "quirq/quirq" },
    { agent: "yash", mode: "watch", project: "quirq/site" },
    { agent: "euler", mode: "agent", project: "" },
    { agent: "ana", mode: "app", project: "quirq/quirq" },
  ];
  const agents = [{ name: "euler", description: "", parent: "quirq", owned: true, connected: true, spaces: ["quirq"], running: [{ host: "mac-mini", since: at(2026, 11, 2) }] }];
  assert.deepEqual(liveRows(here, agents, [], "quirq/quirq"), [
    { name: "euler", agent: true, text: "running on mac-mini" },
    { name: "ana", agent: false, text: "in the app" },
    { name: "yash", agent: false, text: "editing, watching · quirq/site" },
  ]);
  // Without the agent list (a project page), a running agent still counts as one.
  assert.deepEqual(liveRows([{ agent: "euler", mode: "agent", project: "" }]), [{ name: "euler", agent: true, text: "running" }]);
  assert.deepEqual(liveRows([]), []);
});

test("older activity pages join the newest rows: each row once, newest first", () => {
  const rows = (...ids: number[]) => ids.map(id => item("ref_updated", "suraj", String(id)));
  // The page polled 50..48 and loaded 47..45 before; now 52 and 51 arrived on top.
  const merged = mergeActivity(rows(52, 51, 50, 49, 48), rows(48, 47, 46, 45));
  assert.deepEqual(merged.map(row => row.id), ["52", "51", "50", "49", "48", "47", "46", "45"]);
  // Ids past what a number holds still sort right.
  const big = (id: string) => item("ref_updated", "suraj", id);
  assert.deepEqual(mergeActivity([big("9007199254740992")], [big("9007199254740993"), big("10")]).map(row => row.id), ["9007199254740993", "9007199254740992", "10"]);
});
