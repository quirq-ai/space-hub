import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWLIST_HELP, builderAction, inviteState, loginOf, operatorsLine, parseHubSettings, readersLine, stillHere, stillHereText } from "../src/lib/hub-settings.ts";

const answer = {
  owner: "alice",
  operators: ["alice", "ops"],
  adminFallback: false,
  membersOnly: false,
  builders: [{ name: "alice", suspended: false }, { name: "bob", suspended: true }, { name: "carol", suspended: false }],
  join: { policy: "invite" as const, allowlist: ["carol"], invites: [{ id: "1", createdBy: "alice", createdAt: 1000, expiresAt: 2000, usedBy: "" }] },
};
const NOBODY_LISTED = { policy: "anyone", allowlist: [], invites: [] };

test("the hub's settings are read defensively", () => {
  assert.deepEqual(parseHubSettings(answer), answer);
  assert.equal(parseHubSettings(null), null);
  assert.equal(parseHubSettings({ error: "Only the hub's owner manages the hub." }), null);
  assert.deepEqual(parseHubSettings({ owner: "alice", operators: [1, "ops"], builders: [{ name: 2 }, { name: "bob", suspended: "yes" }] }),
    { owner: "alice", operators: ["ops"], adminFallback: false, membersOnly: false, builders: [{ name: "bob", suspended: false }], join: NOBODY_LISTED });
  assert.equal(parseHubSettings({ ...answer, membersOnly: "yes" })!.membersOnly, false, "only true is on");
  assert.equal(parseHubSettings({ ...answer, membersOnly: true })!.membersOnly, true);
  // An older web service sends no join settings, or odd ones: the hub lets anyone in, as before.
  assert.deepEqual(parseHubSettings({ owner: "alice", join: { policy: "members", allowlist: [3, "zed"], invites: [{ id: 4 }, null] } })?.join,
    { policy: "anyone", allowlist: ["zed"], invites: [] });
});

test("an invite reads as used, expired or open for so long", () => {
  const hour = 3_600_000;
  assert.deepEqual(inviteState({ id: "1", createdBy: "a", createdAt: 0, expiresAt: 10 * hour, usedBy: "bob" }, 0), { kind: "used", text: "Used by bob" });
  assert.deepEqual(inviteState({ id: "1", createdBy: "a", createdAt: 0, expiresAt: hour, usedBy: "" }, hour), { kind: "expired", text: "Expired" });
  assert.equal(inviteState({ id: "1", createdBy: "a", createdAt: 0, expiresAt: hour, usedBy: "" }, 0).text, "Open, 1 more hour");
  assert.equal(inviteState({ id: "1", createdBy: "a", createdAt: 0, expiresAt: 7 * 24 * hour, usedBy: "" }, 0).text, "Open, 7 more days");
});

test("a GitHub login is taken as typed, with @ or as a profile link", () => {
  assert.equal(loginOf(" @octocat "), "octocat");
  assert.equal(loginOf("https://github.com/Octo-Cat/"), "Octo-Cat");
  assert.equal(loginOf("not a login"), null);
  assert.equal(loginOf("-bad"), null);
  assert.equal(loginOf(""), null);
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

test("the members-only line says who can read the hub", () => {
  const s = parseHubSettings(answer)!;
  assert.match(readersLine(s), /^Anyone/);
  assert.match(readersLine({ ...s, membersOnly: true }), /^Members only/);
});

test("taking a login off the allowlist points to the builder still here, if there is one", () => {
  const s = parseHubSettings(answer)!;
  assert.equal(stillHere(s, "carol"), "carol", "carol joined: removing her login does not remove her");
  assert.equal(stillHere(s, "Carol"), "carol", "GitHub logins compare without case");
  assert.equal(stillHere(s, "bob"), null, "already suspended: nothing to point to");
  assert.equal(stillHere(s, "alice"), null, "the owner");
  assert.equal(stillHere(s, "dave"), null, "never joined");
  assert.match(stillHereText("carol"), /^carol is still a builder here\..*only stops new joins.*Suspend next to carol in Builders/);
  assert.equal(ALLOWLIST_HELP, "Listing lets an account join. People already in stay until you suspend them below.");
});