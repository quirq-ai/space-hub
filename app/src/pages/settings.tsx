import { Settings } from "lucide-react";
import { PageHeader } from "./common";
import { InstanceRecoveryPage } from "./instance-recovery";

export function SettingsPage({ onConnectionState }: { onConnectionState?: (state: "live" | "offline" | "loading") => void }) {
  return <div className="page settings-page">
    <PageHeader leading={<span className="instance-mark"><Settings size={24} /></span>} title="Settings" subtitle="Manage this Spacehub instance." />
    <InstanceRecoveryPage onConnectionState={onConnectionState} />
  </div>;
}
