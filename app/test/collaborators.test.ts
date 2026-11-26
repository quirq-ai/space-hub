import { test } from "node:test";
import assert from "node:assert/strict";
import { canAdd, candidatesOf, canRemove, chosenOf, COLLABORATOR_HELP, matchCandidates, moveActive, pickerNote, removeConfirm } from "../src/lib/collaborators.ts";

const owner = { canManageCollaborators: true, collaborators: ["dave", "dave-bot"] };
const viewer = { canManageCollaborators: false, collaborators: ["dave", "dave-bot"] };
const older = { collaborators: ["dave"] };

test("only an owner of the project's space adds collaborators; an older hub says nothing, which is no", () => {
  assert.equal(canAdd(owner), true);
  assert.equal(canAdd(viewer), false);
  assert.equal(canAdd(older), false);
});

test("an owner removes anyone listed; a collaborator only leaves; everyone else sees the list only", () => {
  assert.deepEqual(owner.collaborators.map(n => canRemove(owner, "bob", n)), [true, true]);
  assert.deepEqual(viewer.collaborators.map(n => canRemove(viewer, "dave", n)), [true, false], "dave leaves, but not his agent");
  assert.deepEqual(viewer.collaborators.map(n => canRemove(viewer, "carol", n)), [false, false]);
  assert.deepEqual(viewer.collaborators.map(n => canRemove(viewer, null, n)), [false, false], "signed out");
  assert.equal(canRemove(owner, "bob", "erin"), false, "not on the list: nothing to remove");
});

test("removing asks first, and says what is lost", () => {
  assert.match(removeConfirm("bob/site", "dave", "bob"), /^Remove dave from bob\/site\? They will no longer push to it, nor read it if it is private\.$/);
  assert.match(removeConfirm("bob/site", "dave", "dave"), /^Leave bob\/site\? You will no longer push/);
  assert.equal(COLLABORATOR_HELP, "A collaborator can push to this project and read it even when it's private.");
});

// The picker: bob owns the space "acme" (carol is a member, acme-bot is connected), dave already collaborates.
const access = { space: "acme", owners: ["bob"], members: ["carol"], collaborators: ["dave"], agents: ["acme-bot"] };
const hub = {
  entries: [
    { name: "acme", detail: "org · 2 projects" },
    { name: "bob", detail: "builder · 1 project" },
    { name: "carol", detail: "builder · 0 projects" },
    { name: "dave", detail: "builder · 3 projects" },
    { name: "erin", detail: "builder · 1 project" },
    { name: "Frank", detail: "builder · 0 projects" },
    { name: "aaron", detail: "builder · 0 projects" },
    { name: "acme-bot", detail: "agent · 0 projects" },
    { name: "bob-bot", detail: "agent · 0 projects" },
    { name: "erin-bot", detail: "agent · 0 projects" },
  ],
  agents: [{ name: "acme-bot", parent: "acme" }, { name: "bob-bot", parent: "bob" }, { name: "erin-bot", parent: "erin" }],
};

test("the picker offers the hub's builders and your own agents, never anyone who can already push here", () => {
  const offered = candidatesOf(access, hub, "bob");
  assert.deepEqual(offered.map(c => c.name), ["aaron", "bob-bot", "erin", "Frank"]);
  assert.deepEqual(offered.find(c => c.name === "bob-bot"), { name: "bob-bot", kind: "agent" }, "bob's own agent, as the hub allows");
  assert.ok(!offered.some(c => c.name === "erin-bot"), "someone else's agent: the hub would refuse");
  assert.ok(!offered.some(c => ["acme", "bob", "carol", "dave", "acme-bot"].includes(c.name)), "the space, its owners, members, agents and collaborators");
  assert.deepEqual(candidatesOf(access, hub, null).map(c => c.name), ["aaron", "erin", "Frank"], "signed out: no agents of yours");
});

test("typing filters the picker, names that start with it first, ignoring case and @", () => {
  const offered = candidatesOf(access, hub, "bob");
  assert.deepEqual(matchCandidates(offered, "").map(c => c.name), ["aaron", "bob-bot", "erin", "Frank"]);
  assert.deepEqual(matchCandidates(offered, "r").map(c => c.name), ["aaron", "erin", "Frank"]);
  assert.deepEqual(matchCandidates(offered, "R").map(c => c.name), ["aaron", "erin", "Frank"]);
  assert.deepEqual(matchCandidates(offered, "@fr").map(c => c.name), ["Frank"]);
  assert.deepEqual(matchCandidates(offered, "a").map(c => c.name), ["aaron", "Frank"], "aaron starts with it, so comes first");
  assert.deepEqual(matchCandidates(offered, "zed"), []);
  assert.deepEqual(matchCandidates(offered, "dave"), [], "already a collaborator: not offered");
});

test("Add adds exactly the builder picked, or typed in full", () => {
  const offered = candidatesOf(access, hub, "bob");
  assert.equal(chosenOf(offered, "erin")?.name, "erin");
  assert.equal(chosenOf(offered, " @ERIN ")?.name, "erin");
  assert.equal(chosenOf(offered, "eri"), null, "part of a name picks no one");
  assert.equal(chosenOf(offered, "dave"), null, "already has access: nothing to add");
});

test("arrow keys move through the list and wrap; Home and End jump; an empty list has nothing to highlight", () => {
  assert.equal(moveActive(-1, "ArrowDown", 3), 0, "first ArrowDown highlights the first");
  assert.equal(moveActive(0, "ArrowDown", 3), 1);
  assert.equal(moveActive(2, "ArrowDown", 3), 0, "wraps to the top");
  assert.equal(moveActive(-1, "ArrowUp", 3), 2, "ArrowUp from nothing goes to the last");
  assert.equal(moveActive(0, "ArrowUp", 3), 2, "wraps to the bottom");
  assert.equal(moveActive(1, "Home", 3), 0);
  assert.equal(moveActive(1, "End", 3), 2);
  assert.equal(moveActive(1, "x", 3), 1);
  assert.equal(moveActive(0, "ArrowDown", 0), -1);
});

test("the picker says when nobody is left to add, or nobody matches", () => {
  assert.match(pickerNote(0, 0, "", "acme")!, /^Everyone on this hub can already push here: owners and members of acme/);
  assert.equal(pickerNote(4, 0, " zed ", "acme"), "No builder matches “zed”.");
  assert.equal(pickerNote(4, 2, "r", "acme"), null);
  const everyone = { ...access, collaborators: ["dave", "erin", "Frank", "aaron"] };
  assert.deepEqual(candidatesOf(everyone, hub, "carol"), [], "carol owns no agents and every builder has access");
});
