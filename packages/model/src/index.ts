export { auditModelClassOnce } from "./audit.js";
export {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  FieldAwareness,
  PlexusAwareness,
  ReactiveAwareness,
  type AwarenessSerializable,
  type AwarenessShape,
  type AwarenessUpdateChange,
  type AwarenessUpdateListener,
  type ShapeOfAwareness,
} from "./awareness.js";
export { column } from "./column.js";
export {
  applyDocumentUpdate,
  DocumentContainer,
  encodeDocumentStateAsUpdate,
  encodeDocumentStateVector,
  mergeDocumentUpdates,
  type DocumentUpdateListener,
} from "./container.js";
export { model } from "./decorator-model.js";
export { BrokenReferenceError, SchemaAuditError } from "./errors.js";
export { getModelByTag, getModelMetadata, getModelTag, resetModelRegistry } from "./metadata.js";
export { Model, type ModelContainerLink } from "./model.js";
export { hydrateModel, serializeDocument, serializeModel } from "./serialize.js";
export { state } from "./state.js";
export type {
  AssertModelMatchesTable,
  ColumnCodec,
  ColumnMetadata,
  ColumnValue,
  ModelClassMetadata,
  ModelConstructor,
  ModelOptions,
  ModelPatch,
  ModelPatchBatch,
  SerializedDocument,
  SerializedDocumentNode,
  StateFieldKind,
  StateFieldMetadata,
} from "./types.js";
