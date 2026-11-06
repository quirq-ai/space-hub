import type { RoomInfo, RoomQuestion } from "@/api";
import type { ChatTurn } from "./chat-log";

/** Where the explanation of a room's repository is written. */
export const EXPLAINER_OUTPUT = "Chat/explainer/output/one-pager.md";

/** A room's group chat, and the file its turns are saved in. */
export const ROOM_CHAT_FOLDER = "Chat/general";
export const ROOM_CHAT_LOG = "Chat/general/chat.log.jsonl";

/** The repository in a GitHub URL, or null. The explain org's chat takes nothing else, not even "owner/repo" (cli/src/rooms.ts parseGithubUrl agrees). */
export function repoOfGithubUrl(input: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/?#]\S*)?$/i.exec(input.trim());
  return m && m[2] !== "." && m[2] !== ".." ? `${m[1]}/${m[2]}` : null;
}

/** What the explain org's chat replies about a room: its explanation once an agent has answered, else where that stands. */
export function explainReply(room: RoomInfo | undefined, turns: ChatTurn[]): { state: RoomQuestion["state"]; agent: string; answer?: ChatTurn } {
  const question = room?.questions.find(item => item.id === "explain");
  const answer = turns.find(turn => turn.id === "explain-answer");
  return { state: answer ? "answered" : question?.state ?? "waiting", agent: answer?.author ?? question?.agent ?? "", ...(answer ? { answer } : {}) };
}

/** A question still waiting once its wait is over was not picked up; the explanation waits for any agent. */
export function stateNow(question: RoomQuestion, claimSeconds: number, now = Date.now()): RoomQuestion["state"] {
  if (question.state !== "waiting" || question.kind !== "question") return question.state;
  return now - Date.parse(question.askedAt) >= claimSeconds * 1000 ? "unclaimed" : "waiting";
}

/** How many more questions the viewer can ask here today, and why not when none. */
export function questionsLeft(room: RoomInfo): { left: number; why: string } {
  const repo = room.perRepo - room.askedToday;
  const mine = room.perPerson - room.mineToday;
  const left = Math.max(0, Math.min(repo, mine));
  if (left > 0) return { left, why: "" };
  return { left, why: repo <= 0 ? `This repository took its ${room.perRepo} questions for today.` : `You asked your ${room.perPerson} questions here today.` };
}

export const STATE_TEXT: Record<RoomQuestion["state"], (agent: string) => string> = {
  waiting: () => "Waiting for an agent",
  claimed: agent => `${agent} is on it`,
  answered: agent => `Answered by ${agent}`,
  unclaimed: () => "No agent picked this up",
};
