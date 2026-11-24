import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmText, markPrivate, PRIVATE_READERS, PROJECT_VISIBILITIES, PUBLIC_READERS, visibilityActivity, visibilityOf } from "../src/lib/visibility.ts";

test("a project is private only when the hub says so; an older hub says nothing, which is public", () => {
  assert.equal(visibilityOf("private"), "private");
  assert.equal(visibilityOf("public"), "public");
  assert.equal(visibilityOf(undefined), "public");
  assert.equal(visibilityOf("PRIVATE"), "public", "only the hub's own word");
});

test("the control offers public then private, each saying who can see it", () => {
  assert.deepEqual(PROJECT_VISIBILITIES.map(v => v.value), ["public", "private"]);
  assert.equal(PROJECT_VISIBILITIES[1].help, PRIVATE_READERS);
  assert.match(PRIVATE_READERS, /owners and members, its collaborators and their agents/);
  assert.match(PUBLIC_READERS, /Anyone who can read the hub/);
});

test("making a project public is asked first; making it private is not", () => {
  assert.match(confirmText("acme/site", "public") ?? "", /^Make acme\/site public\? Anyone who can read this hub/);
  assert.equal(confirmText("acme/site", "private"), null);
});

test("a visibility change reads as a line of the feed", () => {
  assert.deepEqual(visibilityActivity("private"), { verb: "made private", detail: PRIVATE_READERS });
  assert.deepEqual(visibilityActivity("public"), { verb: "made public", detail: PUBLIC_READERS });
});

test("Recent's locks: a project is marked when its page said private and unmarked when it said public", () => {
  assert.deepEqual(markPrivate([], "a/x", true), ["a/x"]);
  assert.deepEqual(markPrivate(["b/y", "a/x"], "a/x", true), ["a/x", "b/y"], "once, newest first");
  assert.deepEqual(markPrivate(["a/x", "b/y"], "a/x", false), ["b/y"]);
  assert.deepEqual(markPrivate(["b/y"], "a/x", false), ["b/y"]);
  assert.equal(markPrivate(Array.from({ length: 60 }, (_, i) => `s/p${i}`), "a/x", true).length, 50, "kept short");
});
