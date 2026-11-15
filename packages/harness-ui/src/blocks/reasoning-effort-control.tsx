import { Button } from "react-aria-components";

import { Menu, MenuItem, MenuTrigger, NativePopover } from "../primitives/index.js";
import { useVoice } from "../voice/index.js";

/** One selectable option inside the reasoning-effort picker menu. */
export interface ReasoningEffortOption {
  readonly id: string;
  readonly label: string;
  readonly dropsCache?: boolean;
}

export interface ReasoningEffortControlProps {
  readonly triggerWord: string;
  readonly selectedKey: string;
  readonly options: readonly ReasoningEffortOption[];
  readonly disabled?: boolean;
  readonly onSelect: (key: string) => void;
}

/**
 * Text trigger + popover menu for switching reasoning effort with optional cache-invalidation hints.
 */
export function ReasoningEffortControl({
  triggerWord,
  selectedKey,
  options,
  disabled = false,
  onSelect,
}: ReasoningEffortControlProps) {
  const voice = useVoice();
  const triggerLabel = `effort: ${triggerWord}`;

  return (
    <MenuTrigger>
      <Button
        className="effort-trigger label touch-target"
        isDisabled={disabled}
        aria-label={`${voice.composer.effortLabel}: ${triggerWord}`}
      >
        {triggerLabel}
      </Button>
      <NativePopover placement="top-end">
        <Menu
          aria-label={voice.composer.effortLabel}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([selectedKey])}
          onAction={(key) => {
            if (typeof key === "string") onSelect(key);
          }}
        >
          {options.map(({ id, label, dropsCache = false }) => (
            <MenuItem
              key={id}
              id={id}
              textValue={label}
              className="flex items-center justify-between"
              shouldCloseOnSelect
            >
              <span>{label}</span>
              {dropsCache ? <span className="ml-3 text-xs text-muted">drops cache</span> : null}
            </MenuItem>
          ))}
        </Menu>
      </NativePopover>
    </MenuTrigger>
  );
}
