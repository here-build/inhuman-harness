import { useId, useRef, useState } from "react";
import {
  allowedModes,
  CLASS_GROUPS,
  CLASS_LABELS,
  classModeOf,
  classOverrideIn,
  layerConfig,
  resolveCall,
  type ClassId,
  type ClassMode,
} from "@inhuman.tools/harness-model/session";
import { IconSettings } from "@tabler/icons-react";
import { observer } from "mobx-react-lite";
import { Button, Radio, RadioGroup } from "react-aria-components";

import { autoModeProblem } from "./auto-mode-health.js";
import { clusterOf, layersFrom } from "./permissions-view.js";
import { useDial } from "../client/context.js";
import { NativePopover } from "../components/ui/anchored.js";
import { ToggleButton, ToggleButtonGroup } from "../components/ui/form-controls.js";
import { glyph } from "../components/ui/glyph.js";

type Mode = "manual" | "auto" | "yolo";
export type OverrideScope = "session" | "project";

const MODES = [
  ["manual", "manual"],
  ["auto", "auto"],
  ["yolo", "approve all"],
] as const satisfies readonly (readonly [Mode, string])[];

const CLASS_WORDS: Readonly<Record<ClassMode, string>> = { manual: "ask", auto: "auto", always: "always" };

/**
 * The permission modes share one text row; Auto's sprocket opens per-class rules.
 * Absent mode reads as auto. `yolo` is the mode the row calls approve all.
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
  const problemId = useId();
  const mode = onStage == null ? modeOf(dial) : (staged ?? seed ?? "manual");
  const problem =
    mode === "auto" ? autoModeProblem(onStage == null ? dial.session?.root : undefined, dial.kernel?.root) : null;
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
    void (async () => {
      try {
        await modePort.request(method, params);
      } catch {
        // RPC errors surface through the session/kernel link state.
      }
    })();
  };
  return (
    <div className="permission-mode">
      <RadioGroup
        aria-label="Permission mode"
        aria-describedby={problem == null ? undefined : problemId}
        orientation="horizontal"
        className="permission-modes"
        value={mode}
        isDisabled={onStage == null && modePort == null}
        onChange={(value) => {
          if (value === "manual" || value === "auto" || value === "yolo") setMode(value);
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
            {id === "auto" && onStage == null && dial.sessionRpc != null ? <ClassRules mode={mode} /> : null}
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
});

function readProjectOverlay(result: unknown): string {
  if (typeof result !== "object" || result === null || !("layers" in result)) return "";
  const layers: unknown = result.layers;
  if (typeof layers !== "object" || layers === null || !("projectOverlay" in layers)) return "";
  return typeof layers.projectOverlay === "string" ? layers.projectOverlay : "";
}

/** Per-class overrides of the live session. Each row is ask / auto / always; risky rows stop at auto. */
const ClassRules = observer(function ClassRulesView({ mode }: { readonly mode: Mode }) {
  const dial = useDial();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<OverrideScope>("session");
  const [projectOverlay, setProjectOverlay] = useState("");
  const rpc = dial.sessionRpc;
  const rows = overridesOf(dial.session?.root, mode, projectOverlay);
  const custom = rows.filter((row) => row.session !== null || row.project !== null).length;

  const refreshProject = (): void => {
    if (rpc == null) return;
    void (async () => {
      try {
        const result = await rpc.request("policy/config-get", {});
        setProjectOverlay(readProjectOverlay(result));
      } catch {
        // Policy snapshot stays on the last known overlay when the request fails.
      }
    })();
  };
  const setClass = (id: ClassId, next: ClassMode | null): void => {
    if (rpc == null) return;
    void (async () => {
      try {
        await rpc.request("policy/class-mode", { class: id, mode: next, scope });
        refreshProject();
      } catch {
        // Failed override requests keep the previous policy unchanged.
      }
    })();
  };

  return (
    <>
      <Button
        ref={triggerRef}
        className="permission-adjust touch-target"
        aria-label={custom === 0 ? "Adjust auto permissions" : `Adjust auto permissions: ${custom} custom rules`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPress={() => {
          if (!open) refreshProject();
          setOpen(!open);
        }}
      >
        <IconSettings {...glyph} aria-hidden />
      </Button>
      <NativePopover
        className="permission-panel"
        triggerRef={triggerRef}
        isOpen={open}
        onOpenChange={setOpen}
        style={{ positionArea: "top span-left" }}
      >
        <div role="dialog" aria-label="Auto permissions" className="permission-panel-body">
          <div className="permission-scope">
            <span className="text-xs text-muted">Changes apply to</span>
            <ToggleButtonGroup
              aria-label="Scope"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={new Set<OverrideScope>([scope])}
              onSelectionChange={(keys) => {
                const [key] = [...keys];
                if (key === "session" || key === "project") setScope(key);
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
          {CLASS_GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h4 className="permission-group">{group.title}</h4>
              {group.classes.map((id) => {
                const row = rows.find((candidate) => candidate.id === id)!;
                const here = scope === "session" ? row.session : row.project;
                return (
                  <div key={id} className="permission-class" data-overridden={here !== null || undefined}>
                    <span className="permission-class-label" title={id}>
                      {CLASS_LABELS[id]}
                      {row.source === "" ? null : <span className="text-muted"> · {row.source}</span>}
                    </span>
                    <ToggleButtonGroup
                      aria-label={CLASS_LABELS[id]}
                      selectionMode="single"
                      selectedKeys={new Set<ClassMode>([row.effective])}
                      onSelectionChange={(keys) => {
                        const [key] = [...keys];
                        if (key === "manual" || key === "auto" || key === "always") setClass(id, key);
                      }}
                    >
                      {allowedModes(id).map((word) => (
                        <ToggleButton key={word} id={word} className="permission-chip">
                          {CLASS_WORDS[word]}
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                    {here === null ? null : (
                      <Button
                        className="permission-reset"
                        aria-label={`Reset ${CLASS_LABELS[id]} for this ${scope}`}
                        onPress={() => setClass(id, null)}
                      >
                        ×
                      </Button>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </NativePopover>
    </>
  );
});

type OverrideRow = {
  readonly id: ClassId;
  readonly effective: ClassMode;
  readonly session: ClassMode | null;
  readonly project: ClassMode | null;
  /** Where a non-default value comes from: `session`, `project`, `config`, or "" for the mode default. */
  readonly source: string;
};

type AuthRoot = {
  readonly authorizationUserJson: string;
  readonly authorizationProjectJson: string;
  readonly authorizationOverlayJson: string;
};

/** What each class does for an ask in `mode`, and which scope overrides it. */
export function overridesOf(root: AuthRoot | undefined, mode: Mode, projectOverlay: string): OverrideRow[] {
  const texts = {
    user: root?.authorizationUserJson ?? "",
    project: root?.authorizationProjectJson ?? "",
    session: root?.authorizationOverlayJson ?? "",
  };
  const layers = layersFrom(texts);
  const session = layerConfig(texts.session);
  const project = layerConfig(projectOverlay);
  return CLASS_GROUPS.flatMap((group) =>
    group.classes.map((id) => {
      const found = resolveCall(layers, {
        mode,
        cluster: clusterOf(id),
        tier: "ask",
        classes: [id],
        unattended: false,
      });
      const p = classOverrideIn(project, id);
      const source =
        found.layer === "session" ? "session" : found.layer === "user" ? (p !== null ? "project" : "config") : "";
      return { id, effective: classModeOf(found.resolver), session: classOverrideIn(session, id), project: p, source };
    }),
  );
}

function modeOf(dial: ReturnType<typeof useDial>): Mode {
  const session = dial.session?.root;
  const value = session?.permissionMode ?? session?.standingPermissionMode ?? dial.kernel?.root.defaultPermissionMode;
  return value === "manual" || value === "auto" || value === "yolo" ? value : "auto";
}
