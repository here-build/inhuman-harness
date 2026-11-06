import type { InferSelectModel } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

declare global {
  interface SymbolConstructor {
    readonly metadata: unique symbol;
  }
}

export interface ColumnCodec<TDb, TModel = TDb> {
  toModel(dbValue: TDb): TModel;
  toDb(modelValue: TModel): TDb;
}

export interface ColumnMetadata {
  readonly propertyKey: string;
  readonly columnName: string;
  readonly column: SQLiteColumn;
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
  readonly table?: SQLiteTable;
  readonly ignoredColumns: ReadonlySet<string>;
  readonly columns: Map<string, ColumnMetadata>;
  readonly stateFields: Map<string, StateFieldMetadata>;
}

export type AssertModelMatchesTable<
  TTable extends SQLiteTable,
  TInstance,
  TExcluded extends keyof InferSelectModel<TTable> = never,
> = {
  [K in Exclude<keyof InferSelectModel<TTable>, TExcluded>]: K extends keyof TInstance
    ? InferSelectModel<TTable>[K] extends TInstance[K]
      ? unknown
      : {
          readonly __error: "Property type does not match Drizzle column type";
          readonly column: K;
          readonly expected: InferSelectModel<TTable>[K];
          readonly actual: TInstance[K];
        }
    : {
        readonly __error: "Missing Drizzle column on model class";
        readonly column: K;
      };
};

export type ModelPatch =
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
    };

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

export interface SerializedDocument {
  readonly guid?: string;
  readonly revision: number;
  readonly root: SerializedDocumentNode;
  readonly meta?: Record<string, Record<string, unknown>>;
}

export interface ModelOptions<TIgnored extends readonly string[] = readonly string[]> {
  readonly ignoredColumns?: TIgnored;
}

export type ClassLike =
  (abstract new (...args: any[]) => unknown) | { readonly prototype: unknown; readonly name: string };

export type ModelConstructor<TModel = any> = new (...args: any[]) => TModel;
export type AbstractModelConstructor<TModel = any> = abstract new (...args: any[]) => TModel;

export type ColumnValue<TCol extends SQLiteColumn> = TCol extends { _: { data: infer TData; notNull: infer TNotNull } }
  ? TNotNull extends true
    ? TData
    : TData | null
  : unknown;
