import { test } from "node:test";
import assert from "node:assert/strict";
import { isMermaid, isMermaidFence } from "../src/lib/mermaid.ts";

test("Mermaid files are .mmd and .mermaid", () => {
  assert.ok(isMermaid("docs/flow.mmd"));
  assert.ok(isMermaid("Chat/plan/ARCH.MERMAID"));
  assert.ok(!isMermaid("notes.md"));
  assert.ok(!isMermaid("mmd/readme.txt"));
});

test("a ```mermaid block in Markdown is a diagram", () => {
  assert.ok(isMermaidFence("language-mermaid"));
  assert.ok(isMermaidFence("hljs language-mermaid"));
  assert.ok(!isMermaidFence("language-mermaidx"));
  assert.ok(!isMermaidFence(undefined));
});
