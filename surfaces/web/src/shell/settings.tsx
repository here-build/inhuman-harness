import { useState } from "react";
import { SettingsModal, closeOpenSwipes } from "@inhuman.tools/harness-ui";

import { PermissionsPanel } from "./permissions-panel.js";
import { Bots } from "./settings/bots-section.js";
import { AllConnections, Connections } from "./settings/connections-section.js";
import { McpServers } from "./settings/mcp-section.js";
import { Plugins } from "./settings/plugins-section.js";
import { Runtime } from "./settings/runtime-section.js";
import { SECTIONS, type Section } from "./settings/shared.js";
import { Skills } from "./settings/skills-section.js";

const NAV_ITEMS = SECTIONS.map(([id, label]) => ({ id, label }));

/** Modal settings shell composing section navigation and daemon settings panels. */
export function SettingsDialog({ onDismiss }: { readonly onDismiss: () => void }) {
  const [section, setSection] = useState<Section>("connections");
  return (
    <SettingsModal
      items={NAV_ITEMS}
      activeId={section}
      onSelect={(id) => setSection(id as Section)}
      onDismiss={onDismiss}
      onBodyScroll={() => closeOpenSwipes()}
    >
      {section === "connections" ? <AllConnections /> : null}
      {section === "models" ? <Connections /> : null}
      {section === "mcp" ? <McpServers /> : null}
      {section === "plugins" ? <Plugins /> : null}
      {section === "skills" ? <Skills /> : null}
      {section === "bots" ? <Bots /> : null}
      {section === "permissions" ? <PermissionsPanel /> : null}
      {section === "runtime" ? <Runtime /> : null}
    </SettingsModal>
  );
}
