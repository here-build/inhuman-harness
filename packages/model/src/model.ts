import { action, observable } from "mobx";

import { auditModelClassOnce } from "./audit.js";
import type { ReactiveAwareness } from "./awareness.js";
import { getModelMetadata, getModelTag } from "./metadata.js";
import { CONTAINER_LINK, HYDRATION_DATA } from "./symbols.js";
import type { ModelPatch, SerializedModelGraph } from "./types.js";

export interface ModelContainerLink {
  readonly container?: any;
  readonly isApplyingPatches?: boolean;
  readonly awareness?: ReactiveAwareness<any>;
  recordPatch(patch: ModelPatch): void;
  registerNode(node: Model): void;
  notifyDetached?(node: Model): void;
  serializeNode(node: Model): SerializedModelGraph;
  transact<T>(fn: () => T): T;
}

export abstract class Model<TRow = any, TParent = any> {
  static get modelName(): string {
    return getModelTag(this) ?? "";
  }

  readonly uuid: string;
  @observable.ref accessor parent: TParent | null = null;
  @observable.ref accessor parentFieldKey: string | number | null = null;
  [HYDRATION_DATA]?: Record<string, unknown>;
  [CONTAINER_LINK]?: ModelContainerLink;

  constructor(props?: (Partial<TRow> & Record<string, unknown>) | symbol) {
    auditModelClassOnce(new.target);

    const recordProps = props != null && typeof props !== "symbol" ? (props as Record<string, unknown>) : undefined;
    if (recordProps) {
      this[HYDRATION_DATA] = recordProps;
    }

    let resolvedId: string | undefined;

    if (typeof recordProps?.uuid === "string" && recordProps.uuid.length > 0) {
      resolvedId = recordProps.uuid;
    } else if (recordProps) {
      const meta = getModelMetadata(new.target);
      for (const col of meta.columns.values()) {
        if (col.primary) {
          const val =
            recordProps[col.propertyKey] !== undefined ? recordProps[col.propertyKey] : recordProps[col.columnName];
          if (typeof val === "string" && val.length > 0) {
            resolvedId = val;
            break;
          }
        }
      }
    }

    this.uuid = resolvedId ?? crypto.randomUUID();
  }

  get container(): ModelContainerLink | null {
    return this[CONTAINER_LINK] ?? null;
  }

  get document(): any {
    return this[CONTAINER_LINK]?.container ?? this[CONTAINER_LINK] ?? null;
  }

  @action
  applyRow(row: Partial<TRow>): void {
    const meta = getModelMetadata(this.constructor);
    const rowObj = row as Record<string, unknown>;

    for (const col of meta.columns.values()) {
      const raw = rowObj[col.propertyKey] !== undefined ? rowObj[col.propertyKey] : rowObj[col.columnName];
      if (raw !== undefined) {
        const modelVal = col.codec ? col.codec.toModel(raw) : raw;
        const current = (this as any)[col.propertyKey];
        if (!Object.is(current, modelVal)) {
          (this as any)[col.propertyKey] = modelVal;
        }
      }
    }
  }

  toRow(): TRow {
    const meta = getModelMetadata(this.constructor);
    const result: Record<string, unknown> = {};

    for (const col of meta.columns.values()) {
      const modelVal = (this as any)[col.propertyKey];
      const dbVal = col.codec ? col.codec.toDb(modelVal) : modelVal;
      result[col.propertyKey] = dbVal;
      if (col.columnName !== col.propertyKey) {
        Object.defineProperty(result, col.columnName, {
          value: dbVal,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
    }

    return result as TRow;
  }

  toJSON(): Record<string, unknown> {
    const meta = getModelMetadata(this.constructor);
    if (meta.columns.size > 0 || meta.stateFields.size === 0) {
      return this.toRow() as Record<string, unknown>;
    }
    const fields = this as unknown as Record<string, unknown>;
    const result: Record<string, unknown> = { uuid: this.uuid };
    for (const field of meta.stateFields.values()) {
      const value = fields[field.propertyKey];
      const key = field.propertyKey;
      switch (field.kind) {
        case "scalar":
          result[key] = value;
          break;
        case "record":
          result[key] = value && typeof value === "object" ? { ...value } : {};
          break;
        case "ref":
          result[key] = value instanceof Model ? value.uuid : null;
          break;
        case "refList":
          result[key] = Array.isArray(value) ? value.map((item) => (item instanceof Model ? item.uuid : item)) : [];
          break;
        case "child":
          result[key] = value instanceof Model ? value.toJSON() : null;
          break;
        case "childList":
          result[key] = Array.isArray(value) ? value.map((item) => (item instanceof Model ? item.toJSON() : item)) : [];
          break;
        case "childRecord":
          result[key] =
            value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value as Record<string, unknown>).map(([k, item]) => [
                    k,
                    item instanceof Model ? item.toJSON() : item,
                  ]),
                )
              : {};
          break;
        case "list":
          result[key] = Array.isArray(value) ? value.map((item) => (item instanceof Model ? item.uuid : item)) : [];
          break;
      }
    }
    return result;
  }
}
