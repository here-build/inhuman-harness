import { useId, useRef } from "react";
import { IconSettings } from "@tabler/icons-react";
import { Button, Radio, RadioGroup } from "react-aria-components";

import { NativePopover, ToggleButton, ToggleButtonGroup, glyph } from "../primitives/index.js";
import { useVoice } from "../voice/index.js";

export type PermissionModeValue = "manual" | "auto" | "yolo";
export type PermissionOverrideScope = "session" | "project";
export type PermissionClassModeValue = "manual" | "auto" | "always";

/** One policy class override row rendered inside the per-class popover. */
export interface PermissionClassOverrideItem {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly effective: PermissionClassModeValue;
  readonly overridden: boolean;
  readonly allowedModes: readonly PermissionClassModeValue[];
}

/** Grouped list of class overrides rendered inside the per-class popover. */
export interface PermissionClassGroupView {
  readonly title: string;
  readonly classes: readonly PermissionClassOverrideItem[];
}

const MODES: readonly (readonly [PermissionModeValue, string])[] = [
  ["manual", "manual"],
  ["auto", "auto"],
  ["yolo", "approve all"],
];

const CLASS_WORDS: Readonly<Record<PermissionClassModeValue, string>> = {
  manual: "ask",
  auto: "auto",
  always: "always",
};

export interface PermissionModeControlProps {
  readonly mode: PermissionModeValue;
  readonly disabled?: boolean;
  readonly problem?: string | null;
  readonly showAdjust?: boolean;
  readonly adjustOpen?: boolean;
  readonly customCount?: number;
  readonly scope?: PermissionOverrideScope;
  readonly groups?: readonly PermissionClassGroupView[];
  readonly onModeChange: (mode: PermissionModeValue) => void;
  readonly onAdjustOpenChange?: (open: boolean) => void;
  readonly onScopeChange?: (scope: PermissionOverrideScope) => void;
  readonly onClassModeChange?: (classId: string, next: PermissionClassModeValue) => void;
  readonly onClassReset?: (classId: string) => void;
}

/**
 * Horizontal permission-mode radio bar (`manual` / `auto` / `approve all`) with an optional per-class rules popover.
 */
export function PermissionModeControl({
  mode,
  disabled = false,
  problem = null,
  showAdjust = false,
  adjustOpen = false,
  customCount = 0,
  scope = "session",
  groups = [],
  onModeChange,
  onAdjustOpenChange,
  onScopeChange,
  onClassModeChange,
  onClassReset,
}: PermissionModeControlProps) {
  const voice = useVoice();
  const problemId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="permission-mode">
      <RadioGroup
        aria-label={voice.composer.permissionModeLabel}
        aria-describedby={problem == null ? undefined : problemId}
        orientation="horizontal"
        className="permission-modes"
        value={mode}
        isDisabled={disabled}
        onChange={(value) => {
          if (value === "manual" || value === "auto" || value === "yolo") onModeChange(value);
        }}
      >
        {MODES.map(([id, label]) => (
          <div key={id} className="permission-option" data-active={mode === id || undefined}>
            <Radio
              value={id}
              className="permission-word touch-target"
              data-problem={(id === "auto" && problem != null) || undefined}
            >
              {label}
            </Radio>
            {id === "auto" && showAdjust && onAdjustOpenChange != null ? (
              <>
                <Button
                  ref={triggerRef}
                  className="permission-adjust touch-target"
                  aria-label={
                    customCount === 0
                      ? "Adjust auto permissions"
                      : `Adjust auto permissions: ${customCount} custom rules`
                  }
                  aria-haspopup="dialog"
                  aria-expanded={adjustOpen}
                  onPress={() => onAdjustOpenChange(!adjustOpen)}
                >
                  <IconSettings {...glyph} aria-hidden />
                </Button>
                <NativePopover
                  className="permission-panel"
                  triggerRef={triggerRef}
                  isOpen={adjustOpen}
                  onOpenChange={onAdjustOpenChange}
                  placement="top-end"
                >
                  <div role="dialog" aria-label="Auto permissions" className="permission-panel-body">
                    <div className="permission-scope">
                      <span className="text-xs text-muted">Changes apply to</span>
                      <ToggleButtonGroup
                        aria-label="Scope"
                        selectionMode="single"
                        disallowEmptySelection
                        selectedKeys={new Set<PermissionOverrideScope>([scope])}
                        onSelectionChange={(keys) => {
                          const [key] = [...keys];
                          if ((key === "session" || key === "project") && onScopeChange != null) onScopeChange(key);
                        }}
                      >
                        <ToggleButton id="session" className="permission-chip">
                          this session
                        </ToggleButton>
                        <ToggleButton id="project" className="permission-chip">
                          this project
                        </ToggleButton>
                      </ToggleButtonGroup>
                    </div>
                    {groups.map((group) => (
                      <section key={group.title} aria-label={group.title}>
                        <h4 className="permission-group">{group.title}</h4>
                        {group.classes.map((item) => (
                          <div
                            key={item.id}
                            className="permission-class"
                            data-overridden={item.overridden || undefined}
                          >
                            <span className="permission-class-label" title={item.id}>
                              {item.label}
                              {item.source === "" ? null : <span className="text-muted"> · {item.source}</span>}
                            </span>
                            <ToggleButtonGroup
                              aria-label={item.label}
                              selectionMode="single"
                              selectedKeys={new Set<PermissionClassModeValue>([item.effective])}
                              onSelectionChange={(keys) => {
                                const [key] = [...keys];
                                if (
                                  (key === "manual" || key === "auto" || key === "always") &&
                                  onClassModeChange != null
                                ) {
                                  onClassModeChange(item.id, key);
                                }
                              }}
                            >
                              {item.allowedModes.map((word) => (
                                <ToggleButton key={word} id={word} className="permission-chip">
                                  {CLASS_WORDS[word]}
                                </ToggleButton>
                              ))}
                            </ToggleButtonGroup>
                            {!item.overridden || onClassReset == null ? null : (
                              <Button
                                className="permission-reset"
                                aria-label={`Reset ${item.label} for this ${scope}`}
                                onPress={() => onClassReset(item.id)}
                              >
                                ×
                              </Button>
                            )}
                          </div>
                        ))}
                      </section>
                    ))}
                  </div>
                </NativePopover>
              </>
            ) : null}
          </div>
        ))}
      </RadioGroup>
      {problem == null ? null : (
        <p id={problemId} className="permission-problem" role="status">
          {problem}
        </p>
      )}
    </div>
  );
}
