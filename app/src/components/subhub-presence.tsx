import { Server } from "lucide-react";
import { useSubhubNodes } from "@/hooks/use-subhubs";
import { nodesForProject } from "@/lib/subhubs";
import { placeUrl } from "@/api";
import { hashOf, onLink } from "@/router";

export function SubhubPresence({ space, project, compact = false }: { space?: string; project?: string; compact?: boolean }) {
  const resource = useSubhubNodes(space);
  // Stale cached presence is never presented as online after a failed poll.
  const nodes = resource.error ? [] : nodesForProject(resource.data?.nodes ?? [], project).filter(node => node.healthy);
  if (!nodes.length) return null;
  const label = `${nodes.length} sub-hub${nodes.length === 1 ? "" : "s"} online`;
  if (compact) return <span className="subhub-presence strip-here" title={nodes.map(node => `${node.space}/${node.label || node.id}${node.enabled ? "" : " (paused)"}`).join("\n")}><Server size={13} /><i className="online-dot" />{label}</span>;
  return <section className="subhub-presence-list" aria-label="Sub-hubs online"><h2 className="section-title">Sub-hubs online</h2><ul className="people-list">{nodes.map(node => <li key={`${node.space}/${node.id}`}><a href={placeUrl({ space: node.space, project: "" }, hashOf("subhubs"))} onClick={onLink}><Server size={16} /> {node.label || node.id}</a><span className="quiet">{node.mode === "drive" ? "Drive" : "Backups"}{!node.enabled && " · paused"}{node.status === "degraded" && " · needs attention"}</span><i className="online-dot" /></li>)}</ul></section>;
}
