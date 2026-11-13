import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterCheck, dialogFor, HOLD_MS, isHubOutcome, launchpadHome, POLL_MS, STOP_AFTER_MS, stillWatching, watches,
} from "../src/lib/agentshub.ts";

const T = 1_700_000_000_000;

test("the dialog for each outcome; only 'no hub yet' watches", () => {
  assert.equal(dialogFor("nohub"), "waiting");
  assert.equal(dialogFor("hubfailed"), "failed");
  assert.equal(dialogFor("hubstopped"), "stopped");
  assert.equal(dialogFor("hubslow"), "slow");
  assert.deepEqual(["waiting", "timed-out", "failed", "stopped", "slow"].filter(d => watches(d as never)), ["waiting"]);
  assert.equal(isHubOutcome("nohub"), true);
  assert.equal(isHubOutcome("connected"), false);
  assert.equal(isHubOutcome(null), false);
});

test("watching ends just after the server drops the pass (HOLD_MS), whatever the answers", () => {
  assert.equal(stillWatching(T, T + HOLD_MS), true);
  assert.equal(stillWatching(T, T + STOP_AFTER_MS), false);
  // Asking every POLL_MS while the answer stays "waiting": a bounded number of checks, then it stops.
  let checks = 0;
  for (let now = T + POLL_MS; stillWatching(T, now); now += POLL_MS) {
    if ("again" in afterCheck({ state: "waiting" })) checks++;
  }
  assert.ok(checks <= Math.ceil(STOP_AFTER_MS / POLL_MS), `checks ${checks}`);
});

test("after a check: only 'found' moves the browser; every other final answer stops with a dialog", () => {
  assert.deepEqual(afterCheck({ state: "found", go: "/-/runners/agents-hub/wait" }), { go: "/-/runners/agents-hub/wait" });
  assert.deepEqual(afterCheck({ state: "found", go: "https://my-hub.apps.hello-xo.nl/connect?state=x" }), { go: "https://my-hub.apps.hello-xo.nl/connect?state=x" });
  assert.deepEqual(afterCheck({ state: "failed" }), { dialog: "failed" });
  assert.deepEqual(afterCheck({ state: "stopped" }), { dialog: "stopped" });
  assert.deepEqual(afterCheck({ state: "expired" }), { dialog: "timed-out" });
  assert.deepEqual(afterCheck({ state: "waiting" }), { again: true });
  assert.deepEqual(afterCheck(null), { again: true }); // a hiccup: ask again, within the time limit
  assert.deepEqual(afterCheck("nonsense"), { again: true });
});

test("'found' never sends the browser somewhere odd", () => {
  for (const go of ["//evil.example/x", "javascript:alert(1)", "http://evil.example/", "data:text/html,x", 42, "", undefined]) {
    assert.deepEqual(afterCheck({ state: "found", go }), { dialog: "timed-out" }, String(go));
  }
  assert.deepEqual(afterCheck({ state: "found", go: "http://127.0.0.1:7090/connect" }), { go: "http://127.0.0.1:7090/connect" }); // development
});

test("Launchpad's apps list from its create page", () => {
  assert.equal(launchpadHome("https://launchpad-beta.xo.builders/launchpad/new"), "https://launchpad-beta.xo.builders/launchpad");
  assert.equal(launchpadHome("https://app.xo.builders/launchpad/create/agents-hub"), "https://app.xo.builders/launchpad");
  assert.equal(launchpadHome(null), null);
});
