// The starter definition of an agent (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentTemplate } from '../src/agenttemplate.ts';

test('an agent starts in the xo-agent-template layout', () => {
  const files = agentTemplate('scout', 'reads the web');
  for (const f of ['README.md', 'IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'MEMORY.md', 'memory/.gitkeep', 'skills/.gitkeep']) assert.ok(f in files, f);
  assert.match(files['IDENTITY.md'], /scout[\s\S]*reads the web/);
  assert.match(agentTemplate('scout', '')['IDENTITY.md'], /What it does/);
});
