import { useEffect, useId, useState, type ReactNode } from "react";

import { SettingsNav, SettingsSectionHeader, type SettingsNavItem } from "../blocks/settings-blocks.js";
import { cn } from "../lib/cn.js";
import { NativeDialog } from "../primitives/index.js";

/** Props for {@link SettingsModal}. */
export interface SettingsModalProps {
  readonly items: readonly SettingsNavItem[];
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
  readonly onDismiss: () => void;
  readonly onBodyScroll?: () => void;
  readonly navAriaLabel?: string;
  readonly closeLabel?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

/** White-label modal settings shell composing section navigation and scrollable panel body. */
export function SettingsModal({
  items,
  activeId,
  onSelect,
  onDismiss,
  onBodyScroll,
  navAriaLabel,
  closeLabel,
  className,
  children,
}: SettingsModalProps) {
  const titleId = useId();
  const [node, setNode] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (node == null || node.open) return;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
  }, [node]);
  const title = items.find((item) => item.id === activeId)?.label;
  return (
    <NativeDialog
      ref={setNode}
      className={cn("settings-dialog", className)}
      aria-labelledby={titleId}
      onClose={onDismiss}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className="settings-layout">
        <SettingsNav items={items} activeId={activeId} ariaLabel={navAriaLabel} onSelect={onSelect} />
        <div className="settings-body" onScroll={onBodyScroll}>
          <SettingsSectionHeader titleId={titleId} title={title} closeLabel={closeLabel} onClose={onDismiss} />
          {children}
        </div>
      </div>
    </NativeDialog>
  );
}
