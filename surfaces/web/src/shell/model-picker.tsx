import {
  ModelPickerBlock,
  type ModelChoiceItem,
  type ModelWireItem,
  type ProviderRow,
} from "@inhuman.tools/harness-ui";

import { parsePark } from "./connect-park.js";
import type { Request } from "./connect-step.js";

export interface ModelPickerProps {
  readonly wires: readonly ModelWireItem[];
  readonly providers?: readonly ProviderRow[];
  readonly current: ModelChoiceItem;
  readonly disabled: boolean;
  readonly request: Request | null;
  readonly onChoose: (choice: ModelChoiceItem) => void;
  readonly onLook: (connections: readonly string[], drivers: readonly string[]) => void;
}

/** Web adapter connecting OAuth park parsing into ModelPickerBlock. */
export function ModelPicker({ wires, current, disabled, request, onChoose, onLook }: ModelPickerProps) {
  return (
    <ModelPickerBlock
      wires={wires}
      current={current}
      disabled={disabled}
      request={request}
      parsePark={parsePark}
      onChoose={onChoose}
      onLook={onLook}
    />
  );
}
