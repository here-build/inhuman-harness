import { observer } from "mobx-react-lite";
import { Button } from "react-aria-components";

import { useDial } from "../client/context.js";
import { Menu, MenuItem, MenuTrigger, NativePopover } from "../components/ui/anchored.js";

type Mode = "manual" | "auto" | "yolo";

const MODES = [
  ["manual", "manual"],
  ["yolo", "always approve"],
  ["auto", "auto"],
] as const satisfies readonly (readonly [Mode, string])[];

/**
 * The session's permission mode, as a word under the model picker.
 * Absent mode reads as auto. `yolo` is the mode the word calls always approve.
 * A staged pick stays local: it is not the kernel default.
 */
export const PermissionMode = observer(function PermissionModeView({
  staged = null,
  seed = null,
  onStage = null,
}: {
  readonly staged?: Mode | null;
  readonly seed?: Mode | null;
  readonly onStage?: ((mode: Mode) => void) | null;
}) {
  const dial = useDial();
  const mode = onStage == null ? modeOf(dial) : (staged ?? seed ?? "manual");
  const modePort = dial.sessionRpc ?? dial.kernelRpc;
  const setMode = (policy: Mode): void => {
    if (onStage != null) {
      onStage(policy);
      return;
    }
    if (modePort == null) return;
    // A session stores the choice and the last-used default. No session: the kernel default alone.
    const method = dial.sessionRpc == null ? "config/set" : "policy/set";
    const params = dial.sessionRpc == null ? { defaultPermissionMode: policy } : { policy };
    void modePort.request(method, params);
  };
  return (
    <MenuTrigger>
      <Button
        className="permission-trigger label touch-target"
        isDisabled={onStage == null && modePort == null}
        aria-label={`Permission mode: ${wordOf(mode)}`}
      >
        {wordOf(mode)}
      </Button>
      <NativePopover style={{ positionArea: "top span-left" }}>
        <Menu
          aria-label="Permission mode"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set<Mode>([mode])}
          onAction={(key) => {
            if (key === "manual" || key === "auto" || key === "yolo") setMode(key);
          }}
        >
          {MODES.map(([id, label]) => (
            <MenuItem key={id} id={id} shouldCloseOnSelect>
              {label}
            </MenuItem>
          ))}
        </Menu>
      </NativePopover>
    </MenuTrigger>
  );
});

function wordOf(mode: Mode): string {
  if (mode === "auto") return "auto";
  return MODES.find(([id]) => id === mode)?.[1] ?? "auto";
}

function modeOf(dial: ReturnType<typeof useDial>): Mode {
  const session = dial.session?.root;
  const value = session?.permissionMode ?? session?.standingPermissionMode ?? dial.kernel?.root.defaultPermissionMode;
  return value === "manual" || value === "auto" || value === "yolo" ? value : "auto";
}
