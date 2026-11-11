declare global {
  interface SymbolConstructor {
    readonly metadata: unique symbol;
  }
}

export interface DrizzleTableLike<TSelect extends Record<string, any> = any> {
  readonly $inferSelect: TSelect;
}

export interface DrizzleColumnLike<TData = any, TNotNull extends boolean = boolean> {
  readonly name: string;
  readonly notNull: boolean;
  readonly dataType: string;
  readonly columnType: string;
  readonly primary: boolean;
  readonly hasDefault: boolean;
  readonly table: unknown;
  readonly _: {
    readonly data: TData;
    readonly notNull: TNotNull;
  };
}

export interface ColumnCodec<TDb, TModel = TDb> {
  toModel(dbValue: TDb): TModel;
  toDb(modelValue: TModel): TDb;
}

export interface ColumnMetadata {
  readonly propertyKey: string;
  readonly columnName: string;
  readonly column: DrizzleColumnLike;
  readonly notNull: boolean;
  readonly dataType: string;
  readonly columnType: string;
  readonly primary: boolean;
  readonly hasDefault: boolean;
  readonly codec?: ColumnCodec<unknown, unknown>;
}

export type StateFieldKind = "scalar" | "ref" | "child" | "list" | "refList" | "childList" | "record" | "childRecord";

export interface StateFieldMetadata {
  readonly propertyKey: string;
  readonly kind: StateFieldKind;
}

export interface ModelClassMetadata {
  readonly tag: string;
  readonly table?: DrizzleTableLike;
  readonly ignoredColumns: ReadonlySet<string>;
  readonly columns: Map<string, ColumnMetadata>;
  readonly stateFields: Map<string, StateFieldMetadata>;
}

export type AssertModelMatchesTable<
  TTable extends DrizzleTableLike,
  TInstance,
  TExcluded extends keyof TTable["$inferSelect"] = never,
> = {
  [K in Exclude<keyof TTable["$inferSelect"], TExcluded>]: K extends keyof TInstance
    ? TTable["$inferSelect"][K] extends TInstance[K]
      ? unknown
      : {
          readonly __error: "Property type does not match Drizzle column type";
          readonly column: K;
          readonly expected: TTable["$inferSelect"][K];
          readonly actual: TInstance[K];
        }
    : {
        readonly __error: "Missing Drizzle column on model class";
        readonly column: K;
      };
};

export type ModelPatch = (
  | {
      readonly op: "set";
      readonly nodeId: string;
      readonly field: string;
      readonly value: unknown;
      readonly key?: string;
    }
  | {
      readonly op: "splice";
      readonly nodeId: string;
      readonly field: string;
      readonly index: number;
      readonly deleteCount: number;
      readonly items: readonly unknown[];
    }
  | {
      readonly op: "del";
      readonly nodeId: string;
      readonly field: string;
      readonly key: string;
    }
) & { readonly encoding?: "rows-v1" };

export interface ModelPatchBatch {
  readonly revision: number;
  readonly patches: readonly ModelPatch[];
}

export interface SerializedDocumentNode {
  readonly uuid: string;
  readonly tag: string;
  readonly columns: Record<string, unknown>;
  readonly state: Record<string, unknown>;
  readonly refs: Record<string, string | null>;
  readonly refLists: Record<string, readonly string[]>;
  readonly children: Record<string, SerializedDocumentNode | null>;
  readonly childLists: Record<string, readonly SerializedDocumentNode[]>;
  readonly childRecords?: Record<string, Record<string, SerializedDocumentNode>>;
}

/** One entity row. All relationships contain identities, never embedded entities. */
export interface SerializedModelRow {
  readonly uuid: string;
  readonly tag: string;
  readonly columns: Record<string, unknown>;
  readonly state: Record<string, unknown>;
  readonly refs: Record<string, string | null>;
  readonly refLists: Record<string, readonly string[]>;
  readonly children: Record<string, string | null>;
  readonly childLists: Record<string, readonly string[]>;
  readonly childRecords: Record<string, Record<string, string>>;
}

export interface SerializedModelGraph {
  readonly format: "rows-v1";
  readonly uuid: string;
  readonly tag: string;
  readonly nodes: Record<string, SerializedModelRow>;
}

export type SerializedModel = SerializedDocumentNode | SerializedModelGraph;

export interface SerializedDocument {
  readonly guid?: string;
  readonly revision: number;
  readonly root: SerializedModel;
  readonly meta?: Record<string, Record<string, unknown>>;
}

export interface ModelNodeDelta {
  readonly rootId: string;
  readonly revision: number;
  readonly upserts: readonly SerializedModelRow[];
  readonly deletes: readonly string[];
  readonly reset?: boolean;
}

export interface ModelOptions<TIgnored extends readonly string[] = readonly string[]> {
  readonly ignoredColumns?: TIgnored;
}

export type ClassLike =
  (abstract new (...args: any[]) => unknown) | { readonly prototype: unknown; readonly name: string };

export type ModelConstructor<TModel = any> = new (...args: any[]) => TModel;
export type AbstractModelConstructor<TModel = any> = abstract new (...args: any[]) => TModel;

export type ColumnValue<TCol extends DrizzleColumnLike> = TCol extends {
  _: { data: infer TData; notNull: infer TNotNull };
}
  ? TNotNull extends true
    ? TData
    : TData | null
  : unknown;
