/**
 * Shared 11-table Agent DB KV store contract, pure document/shape helpers,
 * and live-shape protocol primitives. Browser-safe and storage-driver-free.
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
export {
  MemoryKvStore,
  MutableCommitAccumulator,
  SESSION_CASCADE_TABLES,
  collectBatchOps,
  compareOrder,
  deduplicateBatchUpserts,
  getRowPrimaryKey,
  matchesWhere,
  mintInitialCommitOffset,
  normalizeHarnessRow,
  type BatchKeySpace,
  type BatchOp,
  type ColumnFilter,
  type CommitDiff,
  type HarnessKvStore,
  type HarnessRowInsertMap,
  type HarnessRowMap,
  type MemoryKvStoreOptions,
  type ReadonlyKeySpace,
  type ScanOrder,
  type ScanQuery,
  type ScanWhere,
  type SetOptions,
  type SpaceDiff,
} from "./kv-store.js";
export {
  buildSessionRuntimeMeta,
  commitScopeNodesInBatch,
  commitSessionNodesInBatch,
  insertSessionBlobInBatch,
  loadScopeNodesFromKv,
  loadSessionDocumentFromKv,
  loadSessionNodesFromKv,
  loadSessionRuntimeMetaFromKv,
  scopeNodeRowId,
  sessionNodeRowId,
  storeSessionDocumentToKv,
  upsertSessionEffectInBatch,
  type LoadedNodeRows,
  type NodeDeltaInput,
} from "./document-kv.js";
export {
  CommitDiffShapeSource,
  LANE_PRIMARY_KEYS,
  LANE_SOURCE_TABLES,
  UpdateLaneHub,
  type CommitDiffShapeSourceOptions,
  type ShapeSource,
} from "./shape-source.js";
export {
  LiveShape,
  applyNodeShapeDelta,
  createLocalShapeTransport,
  type ElectricShapeMessage,
  type LiveShapeOptions,
  type ShapeTransport,
} from "./live-shape.js";
export type { AsyncSecretsStoreBackend, EncryptedSecretRecord, SecretsStoreBackend } from "./secrets.js";
