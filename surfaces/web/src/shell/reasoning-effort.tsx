import {
  formatReasoningEffortLabel,
  isReasoningEffort,
  reasoningEffortOf,
  reasoningProfileFor,
  willEffortSwitchDropCache,
  type ReasoningEffort,
} from "@inhuman.tools/harness-model";
import { observer } from "mobx-react-lite";
import { Button } from "react-aria-components";

import type { ModelChoice, ModelWire } from "./model-choice.js";
import { useDial } from "../client/context.js";
import { Menu, MenuItem, MenuTrigger, NativePopover } from "../components/ui/anchored.js";

/**
 * The session's reasoning effort override, as a word under the model picker.
 * Hidden when the current model does not support reasoning and no override is set.
 * When a warm trajectory exists on the current model, menu items that would
 * invalidate the prompt cache display an explicit `drops cache` hint.
 */
export const ReasoningEffortPicker = observer(function ReasoningEffortPickerView({
  model,
  wires,
  staged = null,
  seed = null,
  agentEffort = null,
  disabled = false,
  onStage = null,
}: {
  readonly model: ModelChoice;
  readonly wires: readonly ModelWire[];
  readonly staged?: ReasoningEffort | "" | null;
  readonly seed?: ReasoningEffort | null;
  readonly agentEffort?: ReasoningEffort | null;
  readonly disabled?: boolean;
  readonly onStage?: ((effort: ReasoningEffort | "") => void) | null;
}) {
  const dial = useDial();
  const wire = wires.find((candidate) => candidate.connection === model.connection);
  const profile = reasoningProfileFor(model.model, {
    ...(wire?.baseUrl === undefined ? {} : { baseUrl: wire.baseUrl }),
    ...wire?.modelCapabilities?.[model.model],
  });

  const rawKv = dial.session?.root.kvs?.reasoningEffort ?? "";
  const selected: ReasoningEffort | "" =
    onStage == null ? (reasoningEffortOf(rawKv) ?? "") : staged !== null ? staged : (seed ?? "");

  if (!profile.supportsReasoning && selected === "") return null;

  const fallbackEffort = agentEffort ?? dial.session?.root.agent?.spec?.reasoningEffort ?? null;
  const effectiveEffort: ReasoningEffort | null = selected === "" ? fallbackEffort : selected;
  const triggerWord = formatReasoningEffortLabel(effectiveEffort);
  const triggerLabel = `effort: ${triggerWord}`;

  const effortPort = dial.sessionRpc ?? dial.kernelRpc;
  const setEffort = (chosen: ReasoningEffort | ""): void => {
    if (onStage != null) {
      onStage(chosen);
      return;
    }
    if (effortPort == null) return;
    void effortPort.request("kv/set", {
      key: "reasoningEffort",
      value: chosen,
      remember: true,
    });
  };

  const sessionKvModel = (dial.session?.root.kvs?.model ?? "").trim();
  const sessionKvConnection = (dial.session?.root.kvs?.connection ?? "").trim();
  const hasWarmTrajectory =
    onStage == null &&
    dial.session?.root.head != null &&
    (sessionKvModel === "" || sessionKvModel === model.model) &&
    (sessionKvConnection === "" || sessionKvConnection === model.connection);

  const effectiveCurrent: ReasoningEffort | null = (selected === "" ? null : selected) ?? fallbackEffort;
  const efforts =
    selected !== "" && !profile.supportedEfforts.includes(selected)
      ? [...profile.supportedEfforts, selected]
      : profile.supportedEfforts;

  const items: readonly {
    readonly id: "default" | ReasoningEffort;
    readonly label: string;
    readonly targetEffective: ReasoningEffort | null;
  }[] = [
    {
      id: "default",
      label: fallbackEffort != null ? `default (${formatReasoningEffortLabel(fallbackEffort)})` : "default",
      targetEffective: fallbackEffort,
    },
    ...efforts.map((effort) => ({
      id: effort,
      label: formatReasoningEffortLabel(effort),
      targetEffective: effort,
    })),
  ];

  const selectedKey = selected === "" ? "default" : selected;

  return (
    <MenuTrigger>
      <Button
        className="effort-trigger label touch-target"
        isDisabled={disabled || (onStage == null && effortPort == null)}
        aria-label={`Reasoning effort: ${triggerWord}`}
      >
        {triggerLabel}
      </Button>
      <NativePopover style={{ positionArea: "top span-left" }}>
        <Menu
          aria-label="Reasoning effort"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([selectedKey])}
          onAction={(key) => {
            if (key === "default") {
              setEffort("");
            } else if (typeof key === "string" && isReasoningEffort(key)) {
              setEffort(key);
            }
          }}
        >
          {items.map(({ id, label, targetEffective }) => {
            const impact = willEffortSwitchDropCache(profile, effectiveCurrent, targetEffective, hasWarmTrajectory);
            return (
              <MenuItem
                key={id}
                id={id}
                textValue={label}
                className="flex items-center justify-between"
                shouldCloseOnSelect
              >
                <span>{label}</span>
                {impact !== "preserve" ? <span className="ml-3 text-xs text-muted">drops cache</span> : null}
              </MenuItem>
            );
          })}
        </Menu>
      </NativePopover>
    </MenuTrigger>
  );
});
