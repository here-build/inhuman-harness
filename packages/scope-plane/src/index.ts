/**
 * Shared 11-table Agent DB plane contract and live-shape protocol helpers.
 * Storage adapters and the browser UI depend only on this browser-safe entrypoint.
 */
export { ScopeKey, coerceCell, pairId, type Cell, type Row } from "./cells.js";
export type { RowMatch, RowPlane, RowReader } from "./row-plane.js";
export {
  HARNESS_TABLE_NAMES,
  columnOf,
  schemaSql,
  tables,
  type CellKind,
  type Column,
  type HarnessTableName,
  type TableDef,
  type TableName,
} from "@inhuman.tools/harness-contract/schema";

export type {
  DatabaseCommitEvent,
  DatabaseCommitListener,
  HarnessDatabase,
  HarnessDatabaseOptions,
  HarnessDrizzleTx,
  HarnessSchema,
  TableRowDelta,
} from "./sqlite-database.js";

export type { UpdateLaneHub } from "./lane-server.js";

export {
  LiveShape,
  applyNodeShapeDelta,
  createLocalShapeTransport,
  type ElectricShapeMessage,
  type LiveShapeOptions,
  type ShapeTransport,
} from "./live-shape.js";
