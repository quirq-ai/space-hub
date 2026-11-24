import { test } from "node:test";
import assert from "node:assert/strict";
import { alreadyIn, builderOf, canAdd, canRemove, COLLABORATOR_HELP, removeConfirm } from "../src/lib/collaborators.ts";

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

test("Add takes a builder name, a GitHub login with @ or a profile link, in any case", () => {
  assert.equal(builderOf(" Dave "), "dave");
  assert.equal(builderOf("@Octo-Cat"), "octo-cat");
  assert.equal(builderOf("https://github.com/octocat/"), "octocat");
  assert.equal(builderOf("two words"), null);
  assert.equal(builderOf(""), null);
  assert.equal(alreadyIn(owner, "dave"), true);
  assert.equal(alreadyIn(owner, "erin"), false);
});

test("removing asks first, and says what is lost", () => {
  assert.match(removeConfirm("bob/site", "dave", "bob"), /^Remove dave from bob\/site\? They will no longer push to it, nor read it if it is private\.$/);
  assert.match(removeConfirm("bob/site", "dave", "dave"), /^Leave bob\/site\? You will no longer push/);
  assert.equal(COLLABORATOR_HELP, "A collaborator can push to this project and read it even when it's private.");
});
