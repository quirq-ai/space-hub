import { Lock } from "lucide-react";
import { PRIVATE_READERS } from "@/lib/visibility";

/**
 * The mark of a private project wherever projects are listed: a label on cards (`PrivateBadge`), a small lock in
 * tight rows (`PrivateMark`: the sidebar, search, the dock). Shown only for projects the viewer can see; a project
 * they can't read is in no list at all.
 */
export function PrivateBadge() {
  return <span className="label private-label" title={`Private. ${PRIVATE_READERS}`}><Lock size={11} aria-hidden="true" />Private</span>;
}

export function PrivateMark({ size = 12 }: { size?: number }) {
  return <span className="private-mark" title={`Private. ${PRIVATE_READERS}`} aria-label="Private" role="img"><Lock size={size} aria-hidden="true" /></span>;
}
