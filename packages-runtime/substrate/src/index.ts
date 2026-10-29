export { ArgsFailureTracker } from "./args-failure-tracker.js";
export { type BoundTool } from "./bound-tool.js";
export { type CalibrationOptions, DEFAULT_CALIBRATION, type ObservationElisionCalibration } from "./calibration.js";
export { type ContentBlock } from "./content-block.js";
export {
  ambiguousBypassDoor,
  bareToolCallDoor,
  DoorSession,
  invalidArgsDoor,
  normalizeSymbolName,
  renderRetryExpr,
  unknownToolDoor,
} from "./doors.js";
export { FutilityTracker } from "./futility.js";
export { DEFAULT_OBSERVATION_MAX_TOTAL_CHARS } from "./render-observation.js";
export { createDoorsRunner, type DoorsRunner } from "./runner.js";
export { KWARGS_STRATEGIES } from "./strategies.js";
export {
  type JsonSchemaProperty,
  type KwargParam,
  orderedFields,
  type ToolJsonSchema,
  type ToolSignature,
} from "./tool-schema.js";
export {
  createSpineLens,
  HINT_RACE_BUDGET_MS,
  type LoweredUnit,
  type MappedDiagnostic,
  renderHint,
  type SchemeSpan,
  selectHints,
  type TypeHintLens,
  type TypeHintsMode,
  type TypeHintTelemetry,
} from "./type-hints/index.js";

// The `display` affordance — a HOST verb, not a language feature (arrival has no IO by design).
// The runner rewrites `(display …)` call forms; the composing host must BIND `displaySymbol()` into
// its capability, or the rewrite targets a name nothing declares.
export { DISPLAY_INTERNAL, displaySymbol, isTopLevelDisplay, stripTopLevelDisplay } from "./display.js";
