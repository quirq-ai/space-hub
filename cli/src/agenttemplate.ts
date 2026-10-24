// The starter definition `spacehub agent create` puts in an agent's home
// project, in the xo-agent-template layout. Owners rewrite it; the agent
// keeps MEMORY.md and memory/ current as it works (autosync pushes them).
export function agentTemplate(name: string, description: string): Record<string, string> {
  const role = description.trim() || 'What it does, in one line.';
  return {
    'README.md': `# ${name}

The definition of the agent **${name}**: who it is, how it works, and what it
remembers. \`spacehub agent run ${name}\` checks this project out next to the
spaces ${name} is connected to and keeps them all in sync.

| File | Holds |
| --- | --- |
| \`IDENTITY.md\` | name and role |
| \`SOUL.md\` | voice and values |
| \`AGENTS.md\` | how it works: routine, rules, where things are |
| \`USER.md\` | who it works for |
| \`TOOLS.md\` | the tools and accounts it may use |
| \`MEMORY.md\`, \`memory/\` | what it learned and keeps |
| \`skills/\` | its skills |
`,
    'IDENTITY.md': `# Identity

## Name

${name}

## Role

${role}
`,
    'SOUL.md': `# Soul

Who ${name} is: its voice, its values, how it talks and decides.
`,
    'AGENTS.md': `# AGENTS.md

How ${name} works.

- Its workspace is the folder \`spacehub agent run\` made: \`${name}/home\` (this
  project) and one folder per connected space, each holding that space's
  projects.
- Files it edits are committed and pushed every few seconds; others' pushes
  arrive the same way. When a conflict pauses a project, resolve it there
  (git status) before going on.
- Keep what is worth remembering in MEMORY.md and memory/.
`,
    'USER.md': `# User

Who ${name} works for, and how they like to work.
`,
    'TOOLS.md': `# Tools

The tools and accounts ${name} may use.
`,
    'MEMORY.md': `# Memory

What ${name} has learned and wants to keep.
`,
    'memory/.gitkeep': '',
    'skills/.gitkeep': '',
  };
}
