/**
 * "Onboard with Claude": the prompt that walks Claude Code through adding an
 * agent to the hub end to end, built from the same commands the Add an agent
 * panel shows, and the link that opens Claude Code with it filled in.
 */

export type OnboardTarget = {
  /** The space the agent is added to; empty on the hub-wide Agents page. */
  space: string;
  /** "org" when the space is an org, so the agent is created inside it. */
  kind: string;
  /** The hub's websocket address, like wss://hub.quirq.dev. */
  server: string;
};

/** Claude Code on the web; it reads `prompt` from the query string and fills the input with it. */
export const CLAUDE_CODE_URL = "https://claude.ai/code";

/** The hub's websocket address for a page served from `origin`. */
export const serverOf = (origin: string) => origin.replace(/^http/, "ws");

export function onboardPrompt({ space, kind, server }: OnboardTarget): string {
  const org = kind === "org" && space;
  const where = space ? `the ${org ? "org" : "space"} \`${space}\`` : "a space I own";
  const create = `spacehub agent create <name>${org ? ` --in ${space}` : ""} -d "<what it does>"`;
  const connect = `spacehub agent connect <name> ${space || "<space>"}`;
  return [
    `Help me add a new agent to my spacehub at ${server}, connected to ${where}, and get it running. Work through the steps below one at a time, run the commands yourself, check each one worked before moving on, and stop to ask me only when you need a decision or a sign-in from me.`,
    "",
    "1. Ask me for the agent's name (lowercase, letters, digits and dashes) and one line on what it should do" + (space ? "." : ", and which space it should push to."),
    "2. Make sure Node 22+ and git are installed, and the spacehub CLI is on PATH (`spacehub --version`). If it is missing, clone https://github.com/quirq-ai/space-hub and run `scripts/install-cli.sh`.",
    `3. Sign in: \`spacehub auth login --server ${server}\`. If it is a GitHub sign-in and \`gh\` is not logged in yet, run \`gh auth login\` first. If \`SPACEHUB_TOKEN\` is already set, skip this. Confirm with \`spacehub auth status\`.`,
    `4. Create the agent: \`${create}\`.${org ? " The org's owners will own it." : " My personal space will own it."}`,
    `5. Connect it so it may push there: \`${connect}\`.`,
    "6. Check it: `spacehub agent view <name>` should list the connection.",
    "7. Write its instructions: `spacehub project clone <name>/home`, fill in SOUL.md, IDENTITY.md, AGENTS.md, MEMORY.md, USER.md and TOOLS.md from what I told you it should do, then commit and `git push quirq main`.",
    "8. Run it: `spacehub agent run <name>` keeps its home and connected spaces in sync and shows it as running on the hub. It is long-running, so start it in the background (or tell me the command if this machine is not where it should live), and restart it if it exits. Exit status 2 means every project is paused on a conflict and needs me.",
    "",
    `When you are done, tell me the agent's name, where it is connected, and its page: ${server.replace(/^ws/, "http")}/<name>.`,
  ].join("\n");
}

/** Claude Code with the onboarding prompt filled in, ready for the person to press send. */
export const claudeCodeLink = (prompt: string) => `${CLAUDE_CODE_URL}?prompt=${encodeURIComponent(prompt)}`;
