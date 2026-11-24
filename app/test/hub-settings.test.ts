import { test } from "node:test";
import assert from "node:assert/strict";
import { builderAction, operatorsLine, parseHubSettings } from "../src/lib/hub-settings.ts";

const answer = {
  owner: "alice",
  operators: ["alice", "ops"],
  adminFallback: false,
  builders: [{ name: "alice", suspended: false }, { name: "bob", suspended: true }, { name: "carol", suspended: false }],
};

test("the hub's settings are read defensively", () => {
  assert.deepEqual(parseHubSettings(answer), answer);
  assert.equal(parseHubSettings(null), null);
  assert.equal(parseHubSettings({ error: "Only the hub's owner manages the hub." }), null);
  assert.deepEqual(parseHubSettings({ owner: "alice", operators: [1, "ops"], builders: [{ name: 2 }, { name: "bob", suspended: "yes" }] }),
    { owner: "alice", operators: ["ops"], adminFallback: false, builders: [{ name: "bob", suspended: false }] });
});

test("the operators line names the owner first, always", () => {
  const s = parseHubSettings(answer)!;
  assert.equal(operatorsLine(s), "alice (owner) and ops.");
  assert.equal(operatorsLine({ ...s, operators: [] }), "alice (owner).");
  assert.equal(operatorsLine({ ...s, operators: ["alice", "ops", "sam"], adminFallback: true }), "alice (owner), ops and sam, and the hub's server admin.");
});

test("the owner can't be suspended; a suspended builder can be restored", () => {
  const s = parseHubSettings(answer)!;
  assert.deepEqual(s.builders.map(b => builderAction(s, b)), [null, "restore", "suspend"]);
});
