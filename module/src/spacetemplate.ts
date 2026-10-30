// The built-in template every hub offers: a goal space, the shape quirq/quirq
// grew into. One goal and the outcomes that prove it (SPACE.md), channels
// that each deliver one output (Chat/), and rules and routines an agent
// follows to keep it moving with little help. Placeholders are filled when a
// project starts from it (space.ts, instantiate).
export const BUILTIN_TEMPLATE = 'goal';

export const BUILTIN_TITLE = 'Goal space';

export const BUILTIN_ABOUT = 'One goal, the outcomes that prove it, channels that each deliver one output, and rules and routines an agent follows to keep it moving.';

const conversation = (title: string, text: string) =>
  JSON.stringify({ type: 'conversation', title, messages: [{ role: 'assistant', content: text }] }, null, 2) + '\n';

export const BUILTIN_FILES: Record<string, string> = {
  'SPACE.md': `# {{project}}

## Goal

{{goal}}

## Outcomes

- [ ] A plan that reaches the goal, in Chat/general — @{{owner}}
- [ ] Replace these with the outcomes that prove the goal is met

## Owners

- {{owner}}

## Rules

- Every piece of work serves an outcome above. Work that serves none is questioned before it starts.
- Work happens in channels under Chat/: one per deliverable, each with an owner, an input and one output.
- Reply in place, extend a channel before opening one, and mark a channel Done when its output is delivered.
- Tick an outcome only with a link to the output that proves it.
- Agents do anything that can be undone and say what they did. They ask an owner only before a step that cannot be undone, a change to these rules, or when the same task failed twice.

## Routines

- Every run: pull, reply to every new message, sort the inbox, regenerate outputs whose inputs changed, tick outcomes that are met, push.
- Every week: post where each outcome stands in Chat/general, and what is next.

## Template

${BUILTIN_ABOUT}
`,

  'README.md': `# {{project}}

{{goal}}

Start with [SPACE.md](SPACE.md): the goal, the outcomes that show it is met,
who owns it, and the rules and routines everyone here follows. The hub shows
it at the top of the space, with how many outcomes are done.

| Folder | Holds |
| --- | --- |
| \`Chat/\` | channels: one per deliverable, each with an input, a conversation and an output |
| \`Vision/\` | why the goal matters and where it leads, as Markdown |
| \`Library/\` | links worth keeping, as \`.url\` files |
| \`Insights/\` | what was learned, as JSON collections |
| \`Activity/\` | what happened, as JSONL feeds |

The rules for laying files out are in [CONTRIBUTING.md](CONTRIBUTING.md).
`,

  'CONTRIBUTING.md': `# Keeping {{project}} organized

[SPACE.md](SPACE.md) says what this space is for. This file says where things go.

## Layout

\`\`\`
SPACE.md           goal, outcomes, owners, rules, routines
README.md          what the space is
CONTRIBUTING.md    these rules
CLAUDE.md          the same, pointed at for agents
Chat/              channels: Chat/<channel>/
Vision/            direction documents, *.md
Library/           web shortcuts, *.url
Insights/          insight collections, *.json
Activity/          feed events, *.jsonl
\`\`\`

- Every folder has a \`README.md\` that says what goes in it.
- File names are lowercase kebab-case. Links are relative to the space's root.
- No secrets, generated files or duplicate copies.

## Channels

\`\`\`
Chat/<channel>/
  README.md     "# Title", then "## Owner", "## Status", "## Input" and "## Output format"
  chat.json     the conversation (the hub's chat box adds chat.log.jsonl beside it)
  inputs/       files for this channel, any type
  output/       the one result, in the output format
\`\`\`

- **Input, action, output.** The owner writes what is asked under \`## Input\`.
  People and agents talk in the conversation and add files to \`inputs/\`. The
  result goes to \`output/\`, and is regenerated when the inputs change.
- **Output format** is one of Slides (\`output/slides.md\`), One pager
  (\`output/one-pager.md\`), Website (\`output/index.html\`) or GitHub URL
  (\`output/github.url\`).
- **Status** is Open, Waiting (blocked on one person, whose question is the
  last turn) or Done. A new message reopens a Done channel.
- **Few channels, many messages.** Reply in place. Extend a channel's Input
  before opening a new one. Merge channels that head to the same output.
- **Sub-channels** (\`Chat/<channel>/<piece>/\`, one level deep) are for a piece
  that needs its own owner and output. Fold them back when they are Done.
- Files dropped straight into \`Chat/\` are the inbox: they get sorted into the
  \`inputs/\` of the channel they serve.

## Outcomes

An outcome in SPACE.md is ticked (\`- [x]\`) only when an output proves it.
Link that output on the same line. When the goal changes, change SPACE.md
first, then the channels.
`,

  'CLAUDE.md': `# CLAUDE.md

This is a goal space. Read [SPACE.md](SPACE.md) first: its goal and outcomes
decide what is worth doing, its rules say how, and its routines are what you
run each time you work here. Lay files out as [CONTRIBUTING.md](CONTRIBUTING.md)
says.

- Act on anything that can be undone, then say what you did and link it.
- Ask an owner (SPACE.md, ## Owners) only before a step that cannot be undone,
  a change to the rules, or when the same task failed twice. Ask in their
  channel, with the option you recommend, and set the blocked channel to Waiting.
- Reply in three parts: the answer, what changed (links), the next step.
- When an output proves an outcome, tick it in SPACE.md with a link to it.
`,

  'Chat/README.md': `# Chat

Channels: one folder per deliverable, each with an owner, an input, a
conversation and one output. See CONTRIBUTING.md, Channels. Drop a file here
and it will be sorted into the channel it serves.
`,

  'Chat/general/README.md': `# General

## Owner

{{owner}}

## Status

Open

## Input

Plan how to reach the goal: {{goal}} List the outcomes that will prove it,
who owns each, and the channels that will deliver them.

## Output format

One pager
`,

  'Chat/general/chat.json': conversation('General', 'This space started on {{date}} with one goal: {{goal}} Say what you know so far, drop files in inputs/, and the plan will take shape in output/one-pager.md.'),
  'Chat/general/inputs/.gitkeep': '',
  'Chat/general/output/.gitkeep': '',

  'Vision/README.md': `# Vision

Why the goal matters and where it leads, as Markdown documents.
`,

  'Library/README.md': `# Library

Links worth keeping, one \`.url\` file each.
`,

  'Insights/README.md': `# Insights

What was learned along the way, as JSON collections.
`,

  'Activity/README.md': `# Activity

What happened, as JSONL feeds: one event per line.
`,
};
