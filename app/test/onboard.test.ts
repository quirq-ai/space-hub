import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeLink, onboardPrompt, serverOf } from "../src/lib/onboard.ts";

test("the org prompt creates the agent in the org and connects it there", () => {
  const prompt = onboardPrompt({ space: "quirq", kind: "org", server: "wss://hub.quirq.dev" });
  assert.match(prompt, /spacehub agent create <name> --in quirq -d "<what it does>"/);
  assert.match(prompt, /spacehub agent connect <name> quirq/);
  assert.match(prompt, /spacehub auth login --server wss:\/\/hub\.quirq\.dev/);
  assert.match(prompt, /spacehub agent run <name>/);
  assert.match(prompt, /https:\/\/hub\.quirq\.dev\/<name>/);
});

test("the hub-wide prompt asks which space and does not create inside an org", () => {
  const prompt = onboardPrompt({ space: "", kind: "hub", server: "wss://hub.quirq.dev" });
  assert.doesNotMatch(prompt, /--in /);
  assert.match(prompt, /spacehub agent connect <name> <space>/);
  assert.match(prompt, /which space it should push to/);
});

test("the link fills Claude Code's prompt and survives the round trip", () => {
  const prompt = onboardPrompt({ space: "suraj", kind: "personal", server: serverOf("https://hub.quirq.dev") });
  const url = new URL(claudeCodeLink(prompt));
  assert.equal(url.origin + url.pathname, "https://claude.ai/code");
  assert.equal(url.searchParams.get("prompt"), prompt);
  assert.equal(serverOf("http://localhost:3000"), "ws://localhost:3000");
});
