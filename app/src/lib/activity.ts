import type { ActivityItem, AgentInfo, Here } from "@/api";

/** What someone connected is doing, by presence mode. */
export const MODES: Record<string, string> = { watch: "watching", sync: "syncing", autosync: "editing", agent: "running", app: "in the app" };

/** "Today", "Yesterday", the weekday this past week, else the date. */
export function dayOf(iso: string, now = new Date()): string {
  const day = new Date(iso);
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(now) - start(day)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return day.toLocaleDateString("en-US", { weekday: days < 7 ? "long" : undefined, month: "short", day: "numeric", year: day.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export const FILTERS = [{ key: "all", label: "All" }, { key: "pushes", label: "Pushes" }, { key: "agents", label: "Agents" }, { key: "people", label: "People" }] as const;
export type ActivityFilter = typeof FILTERS[number]["key"];

// Builders who made, connected or removed an agent show under Agents too; "agent_registered" is a builder joining.
const AGENT_KIND = /^agent_(?!registered)/;

/**
 * Whether an activity row shows under a filter: everything, pushes, what
 * agents did (or what was done to them), or what builders did. `agents`
 * names the agents, since a row only says who.
 */
export function keepActivity(filter: ActivityFilter, item: ActivityItem, agents: Set<string>): boolean {
  if (filter === "pushes") return item.kind.startsWith("ref_");
  if (filter === "agents") return agents.has(item.agent) || AGENT_KIND.test(item.kind);
  if (filter === "people") return !!item.agent && !agents.has(item.agent);
  return true;
}

export type LiveRow = { name: string; agent: boolean; text: string };

/**
 * Who is connected now, each once: agents first, with the machine they run
 * on when known, then people with what they are doing and where. `place`
 * (the project being viewed) is left out of where.
 */
export function liveRows(here: Here[], agents: AgentInfo[] = [], known: string[] = [], place = ""): LiveRow[] {
  const hosts = new Map(agents.map(agent => [agent.name, agent.running.map(run => run.host).filter(Boolean)]));
  const isAgent = new Set([...known, ...agents.map(agent => agent.name)]);
  const byName = new Map<string, Here[]>();
  for (const who of here) byName.set(who.agent, [...(byName.get(who.agent) ?? []), who]);
  return [...byName].map(([name, rows]) => {
    const running = rows.some(row => row.mode === "agent");
    const where = [...new Set(rows.map(row => row.project).filter(project => project && project !== place))];
    const machines = hosts.get(name) ?? [];
    const doing = running ? `running${machines.length ? ` on ${machines.join(", ")}` : ""}` : [...new Set(rows.map(row => MODES[row.mode] ?? row.mode))].join(", ");
    const at = where.length > 2 ? `${where.slice(0, 2).join(", ")} and ${where.length - 2} more` : where.join(", ");
    return { name, agent: running || isAgent.has(name), text: [doing, at].filter(Boolean).join(" · ") };
  }).sort((a, b) => Number(b.agent) - Number(a.agent) || a.name.localeCompare(b.name));
}
