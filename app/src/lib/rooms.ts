import type { RoomInfo, RoomQuestion } from "@/api";

/** Where the explanation of a room's repository is written. */
export const EXPLAINER_OUTPUT = "Chat/explainer/output/one-pager.md";

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
