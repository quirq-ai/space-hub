import { useState } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { claudeCodeLink, onboardPrompt, serverOf, type OnboardTarget } from "@/lib/onboard";

/** Claude's spark: rounded rays of uneven length around a center, in Claude's clay color. */
export function ClaudeSpark({ size = 18 }: { size?: number }) {
  const rays = [10, 7.4, 9.2, 6.8, 10, 7.8, 9, 6.6, 9.8, 7.2, 9.4, 7];
  return <svg className="claude-spark" width={size} height={size} viewBox="-12 -12 24 24" aria-hidden="true">
    {rays.map((length, i) => <line key={i} x1="0" y1="0" x2="0" y2={-length} transform={`rotate(${i * 30 + 4})`} />)}
  </svg>;
}

/**
 * "Onboard with Claude", under the Add an agent commands: one click copies a
 * prompt that adds the agent end to end and opens Claude Code with it filled in.
 */
export function ClaudeOnboard({ space, kind }: Omit<OnboardTarget, "server">) {
  const [state, setState] = useState<"idle" | "copied" | "opened">("idle");
  const prompt = onboardPrompt({ space, kind, server: serverOf(location.origin) });
  const open = () => {
    // Open first, inside the click, so the browser does not treat it as a popup; the copy can finish after.
    const tab = window.open(claudeCodeLink(prompt), "_blank", "noopener");
    navigator.clipboard?.writeText(prompt).then(() => setState("copied"), () => setState("opened"));
    if (!navigator.clipboard) setState(tab === null ? "idle" : "opened");
    setTimeout(() => setState("idle"), 2600);
  };
  return <div className="claude-onboard">
    <button type="button" className={`claude-button${state !== "idle" ? " done" : ""}`} onClick={open} title="Copies the prompt and opens Claude Code with it">
      <span className="claude-button-mark"><ClaudeSpark size={18} /></span>
      <span className="claude-button-text" role="status">{state === "idle" ? "Onboard with Claude Code" : "Copied, opening Claude Code"}</span>
      <span className="claude-button-arrow">{state === "idle" ? <ArrowUpRight size={16} /> : <Check size={16} />}</span>
    </button>
    <p className="claude-onboard-note">Claude Code sets up the agent for you: create, connect and run.</p>
  </div>;
}
