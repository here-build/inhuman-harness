import { useState } from "react";
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
import { autoModeProblem } from "@inhuman.tools/harness-transcript/names";
import {
  PermissionModeControl,
  type PermissionClassGroupView,
  type PermissionModeValue,
  type PermissionOverrideScope,
} from "@inhuman.tools/harness-ui";
import { observer } from "mobx-react-lite";

import { clusterOf, layersFrom } from "./permissions-view.js";
import { useDial } from "../client/context.js";

type Mode = PermissionModeValue;
export type OverrideScope = PermissionOverrideScope;

function isClassId(id: string): id is ClassId {
  return Object.hasOwn(CLASS_LABELS, id);
}

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
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<OverrideScope>("session");
  const [projectOverlay, setProjectOverlay] = useState("");

  const mode = onStage == null ? modeOf(dial) : (staged ?? seed ?? "manual");
  const problem =
    mode === "auto" ? autoModeProblem(onStage == null ? dial.session?.root : undefined, dial.kernel?.root) : null;
  const modePort = dial.sessionRpc ?? dial.kernelRpc;
  const showAdjust = onStage == null && dial.sessionRpc != null;

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

  const rpc = dial.sessionRpc;
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

  const rows = showAdjust ? overridesOf(dial.session?.root, mode, projectOverlay) : [];
  const customCount = rows.filter((row) => row.session !== null || row.project !== null).length;
  const groups: PermissionClassGroupView[] = showAdjust
    ? CLASS_GROUPS.map((group) => ({
        title: group.title,
        classes: group.classes.map((id) => {
          const row = rows.find((candidate) => candidate.id === id)!;
          const here = scope === "session" ? row.session : row.project;
          return {
            id,
            label: CLASS_LABELS[id],
            source: row.source,
            effective: row.effective,
            overridden: here !== null,
            allowedModes: allowedModes(id),
          };
        }),
      }))
    : [];

  return (
    <PermissionModeControl
      mode={mode}
      disabled={onStage == null && modePort == null}
      problem={problem}
      showAdjust={showAdjust}
      adjustOpen={open}
      customCount={customCount}
      scope={scope}
      groups={groups}
      onModeChange={setMode}
      onAdjustOpenChange={(nextOpen) => {
        if (nextOpen && !open) refreshProject();
        setOpen(nextOpen);
      }}
      onScopeChange={setScope}
      onClassModeChange={(classId, next) => {
        if (isClassId(classId)) setClass(classId, next);
      }}
      onClassReset={(classId) => {
        if (isClassId(classId)) setClass(classId, null);
      }}
    />
  );
});

function readProjectOverlay(result: unknown): string {
  if (typeof result !== "object" || result === null || !("layers" in result)) return "";
  const layers: unknown = result.layers;
  if (typeof layers !== "object" || layers === null || !("projectOverlay" in layers)) return "";
  return typeof layers.projectOverlay === "string" ? layers.projectOverlay : "";
}

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
