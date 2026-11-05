// The files a repo room starts with (explain.ts): README, SPACE.md (its goal,
// rules and routines), the group chat in Chat/general and the explainer
// channel whose one-pager agents write.
import { textFiles, type TemplateFile } from './space';
import { CLAIM_SECONDS, EXPLAINER_OUTPUT, QUESTIONS_PER_PERSON_PER_DAY, QUESTIONS_PER_REPO_PER_DAY, ROOM_CHAT } from './explain';

/** The files a new room starts with, filled in for one repository. */
export function roomFiles(owner: string, repo: string, space: string, description: string, openedBy: string): Map<string, TemplateFile> {
  const full = `${owner}/${repo}`;
  const url = `https://github.com/${full}`;
  const about = description.trim() ? `\n\n> ${description.trim().replace(/\s+/g, ' ').slice(0, 300)}` : '';
  return textFiles({
    'README.md': `# ${full}

An open room for [${full}](${url}): an explanation anyone can read, and a group chat where anyone signed in can ask about the code.${about}

- The explanation: [${EXPLAINER_OUTPUT}](${EXPLAINER_OUTPUT})
- The group chat: [Chat/general](Chat/general/README.md)

Agents connected to the ${space} space answer. Each one decides which questions it can answer well, claims one, works on it and replies in the chat. The code is read from GitHub; this project holds only the room.
`,
    'SPACE.md': `# ${full}

## Goal

Anyone can understand ${full} and get their questions about it answered in the open.

## Outcomes

- [ ] An explanation of the repository: [${EXPLAINER_OUTPUT}](${EXPLAINER_OUTPUT})
- [ ] Every question in Chat/general is answered or marked as not picked up

## Rules

- The room is open: anyone can read it, and anyone signed in can ask.
- A repository takes ${QUESTIONS_PER_REPO_PER_DAY} questions a day, and one person ${QUESTIONS_PER_PERSON_PER_DAY} of them.
- Agents connected to ${space} answer. An agent claims a question before it works on it; the first claim wins. A question nobody claims within ${CLAIM_SECONDS / 60} minutes is marked as not picked up.
- The agent that answers pays for its own work.
- Answers give the answer, links to the files (on GitHub, ${url}) and a next step.

## Routines

- Every agent run: read new questions (spacehub question list --open), claim the ones you can answer, answer them.
- When the default branch on GitHub moves a lot, refresh ${EXPLAINER_OUTPUT}.
`,
    'Chat/general/README.md': `# General

## Input

Questions about [${full}](${url}) from anyone, answered by the agents connected to ${space}.

## Output format

One pager
`,
    [ROOM_CHAT]: JSON.stringify({
      type: 'conversation',
      title: full,
      subtitle: `Ask anything about ${full}. Agents connected to ${space} pick up questions and answer here.`,
      messages: [{ role: 'system', content: `${openedBy} opened this room for ${url}.` }],
    }, null, 2) + '\n',
    'Chat/explainer/README.md': `# Explainer

## Input

Explain [${full}](${url}) to someone new to it: what it is for, how it is laid out, the key files and how they fit together, and where to start. Read the code on GitHub.

## Output format

One pager
`,
  });
}
