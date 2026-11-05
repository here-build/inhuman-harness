import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import type {
  ClassLike,
  ColumnMetadata,
  ModelClassMetadata,
  ModelConstructor,
  ModelOptions,
  StateFieldMetadata,
} from "./types.js";

// Ensure Symbol.metadata is available at runtime
const symbolMetadata = (Symbol as { metadata?: symbol }).metadata ?? Symbol.for("Symbol.metadata");
(Symbol as { metadata: symbol }).metadata = symbolMetadata;

export const MODEL_META_SYMBOL = Symbol("MODEL_META_SYMBOL");
export const COLUMN_META_SYMBOL = Symbol("COLUMN_META_SYMBOL");
export const STATE_META_SYMBOL = Symbol("STATE_META_SYMBOL");

const tagToConstructor = new Map<string, ModelConstructor>();
const constructorToTag = new Map<ClassLike, string>();

export function registerModelClass(tag: string, ctor: ClassLike, table?: SQLiteTable, options?: ModelOptions): void {
  const existing = tagToConstructor.get(tag);
  if (existing) {
    if (existing === ctor) {
      return;
    }
    throw new Error(`Model tag "${tag}" is already registered to class "${existing.name || "Unknown"}"`);
  }

  tagToConstructor.set(tag, ctor as ModelConstructor);
  constructorToTag.set(ctor, tag);

  const ignoredSet = new Set<string>(options?.ignoredColumns);
  (ctor as unknown as Record<symbol, unknown>)[MODEL_META_SYMBOL] = {
    table,
    ignoredColumns: ignoredSet,
  };
}

export function getModelByTag(tag: string): ModelConstructor | undefined {
  return tagToConstructor.get(tag);
}

export function getModelTag(ctor: ClassLike): string | undefined {
  return constructorToTag.get(ctor);
}

export function resetModelRegistry(): void {
  tagToConstructor.clear();
  constructorToTag.clear();
}

export function registerColumnMetadata(context: ClassAccessorDecoratorContext, metadata: ColumnMetadata): void {
  const ctxMeta = context.metadata as Record<symbol, unknown> | null;
  if (ctxMeta) {
    let colMap = ctxMeta[COLUMN_META_SYMBOL] as Map<string, ColumnMetadata> | undefined;
    if (!colMap) {
      colMap = new Map();
      ctxMeta[COLUMN_META_SYMBOL] = colMap;
    }
    colMap.set(metadata.propertyKey, metadata);
  }

  context.addInitializer(function (this: unknown) {
    const self = this as { constructor: ClassLike };
    const ctor = self.constructor as unknown as Record<symbol, unknown>;
    let colMap = ctor[COLUMN_META_SYMBOL] as Map<string, ColumnMetadata> | undefined;
    if (!colMap) {
      colMap = new Map();
      ctor[COLUMN_META_SYMBOL] = colMap;
    }
    colMap.set(metadata.propertyKey, metadata);
  });
}

export function registerStateMetadata(context: ClassAccessorDecoratorContext, metadata: StateFieldMetadata): void {
  const ctxMeta = context.metadata as Record<symbol, unknown> | null;
  if (ctxMeta) {
    let stateMap = ctxMeta[STATE_META_SYMBOL] as Map<string, StateFieldMetadata> | undefined;
    if (!stateMap) {
      stateMap = new Map();
      ctxMeta[STATE_META_SYMBOL] = stateMap;
    }
    stateMap.set(metadata.propertyKey, metadata);
  }

  context.addInitializer(function (this: unknown) {
    const self = this as { constructor: ClassLike };
    const ctor = self.constructor as unknown as Record<symbol, unknown>;
    let stateMap = ctor[STATE_META_SYMBOL] as Map<string, StateFieldMetadata> | undefined;
    if (!stateMap) {
      stateMap = new Map();
      ctor[STATE_META_SYMBOL] = stateMap;
    }
    stateMap.set(metadata.propertyKey, metadata);
  });
}

export function getModelMetadata(ctor: ClassLike): ModelClassMetadata {
  const tag = constructorToTag.get(ctor) ?? "";
  const classData = (ctor as unknown as Record<symbol, unknown>)[MODEL_META_SYMBOL] as
    { table?: SQLiteTable; ignoredColumns: Set<string> } | undefined;

  const columns = new Map<string, ColumnMetadata>();
  const stateFields = new Map<string, StateFieldMetadata>();

  // 1. Read from Symbol.metadata if present
  const metaObj = (ctor as unknown as Record<symbol, unknown>)[Symbol.metadata] as Record<symbol, unknown> | undefined;
  if (metaObj) {
    const metaCols = metaObj[COLUMN_META_SYMBOL] as Map<string, ColumnMetadata> | undefined;
    if (metaCols) {
      for (const [k, v] of metaCols.entries()) {
        columns.set(k, v);
      }
    }
    const metaStates = metaObj[STATE_META_SYMBOL] as Map<string, StateFieldMetadata> | undefined;
    if (metaStates) {
      for (const [k, v] of metaStates.entries()) {
        stateFields.set(k, v);
      }
    }
  }

  // 2. Read prototype chain fallback maps
  let curr: ClassLike | null = ctor;
  const hierarchy: ClassLike[] = [];
  while (curr && (curr as unknown) !== Object && (curr as unknown) !== Function) {
    hierarchy.unshift(curr);
    curr = Object.getPrototypeOf(curr) as ClassLike | null;
  }

  for (const c of hierarchy) {
    const cRec = c as unknown as Record<symbol, unknown>;
    const cCols = cRec[COLUMN_META_SYMBOL] as Map<string, ColumnMetadata> | undefined;
    if (cCols) {
      for (const [k, v] of cCols.entries()) {
        columns.set(k, v);
      }
    }
    const cStates = cRec[STATE_META_SYMBOL] as Map<string, StateFieldMetadata> | undefined;
    if (cStates) {
      for (const [k, v] of cStates.entries()) {
        stateFields.set(k, v);
      }
    }
  }

  return {
    tag,
    table: classData?.table,
    ignoredColumns: classData?.ignoredColumns ?? new Set(),
    columns,
    stateFields,
  };
}
