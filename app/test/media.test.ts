import { test } from "node:test";
import assert from "node:assert/strict";
import { localLink, mediaOf } from "../src/lib/media.ts";

test("images and video by extension", () => {
  assert.equal(mediaOf("Library/logo.PNG"), "image");
  assert.equal(mediaOf("art/mark.svg"), "image");
  assert.equal(mediaOf("Chat/demo/output/walkthrough.mp4"), "video");
  assert.equal(mediaOf("clips/take.mov"), "video");
  assert.equal(mediaOf("notes.md"), undefined);
  assert.equal(mediaOf("mp4"), undefined);
});

test("a Markdown link or image as a path in the project", () => {
  assert.equal(localLink("shots/one.png", "Chat/a/README.md"), "Chat/a/shots/one.png");
  assert.equal(localLink("../b/clip.mp4", "Chat/a/README.md"), "Chat/b/clip.mp4");
  assert.equal(localLink("/Library/logo.png", "Chat/a/README.md"), "Library/logo.png");
  assert.equal(localLink("my%20shot.png?raw=1#top", "README.md"), "my shot.png");
  assert.equal(localLink("../../out.png", "README.md"), undefined);
  assert.equal(localLink("https://example.com/a.png", "README.md"), undefined);
  assert.equal(localLink("data:image/png;base64,AAAA", "README.md"), undefined);
});
