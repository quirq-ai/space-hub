import { Settings } from "lucide-react";
import { PageHeader } from "./common";
import { InstanceRecoveryPage } from "./instance-recovery";
import { RunnersSection } from "./runners";
import { HubSettingsSection } from "./hub-settings";

export function SettingsPage({ onConnectionState, signedIn = false, operator = false, owner = false }: { onConnectionState?: (state: "live" | "offline" | "loading") => void; signedIn?: boolean; operator?: boolean; owner?: boolean }) {
  return <div className="page settings-page">
    <PageHeader leading={<span className="instance-mark"><Settings size={24} /></span>} title="Settings" subtitle="Manage this Spacehub instance." />
    {signedIn && owner && <HubSettingsSection />}
    {signedIn && <RunnersSection />}
    {operator && <InstanceRecoveryPage onConnectionState={onConnectionState} />}
    {!signedIn && !operator && <p className="quiet">Sign in to manage your runners.</p>}
  </div>;
}
