/**
 * Scope tree shared by the local harness and the cloud runtime.
 * Storage adapters are separate packages and depend only on this API.
 */
export { ScopeCycle, ScopeKey, ScopeMissing, coerceCell, pairId, type Cell, type Row } from "./cells.js";
export {
  createScopePlane,
  type ConfigPatch,
  type ConfigValue,
  type EffectiveConfig,
  type AgentCallWrite,
  type OverviewWrite,
  type ScopePlane,
  type ScopeStamp,
  type ScopeView,
} from "./plane.js";
export type { GenerationClaim, OwnedMutation, RowMatch, RowPlane, RowReader } from "./row-plane.js";
export {
  columnOf,
  configFieldNames,
  schemaSql,
  tables,
  type CellKind,
  type Column,
  type ConfigField,
  type TableDef,
  type TableName,
} from "./schema.js";

export {
  HARNESS_TABLE_NAMES,
  HarnessDatabase,
  harnessSchema,
  type DatabaseCommitEvent,
  type DatabaseCommitListener,
  type HarnessDatabaseOptions,
  type HarnessDrizzleTx,
  type HarnessSchema,
  type HarnessTableName,
} from "./sqlite-database.js";

export { LANE_PRIMARY_KEYS, LANE_SOURCE_TABLES, UpdateLaneHub } from "./lane-server.js";

export { LiveShape, createLocalShapeTransport, type LiveShapeOptions, type ShapeTransport } from "./live-shape.js";
