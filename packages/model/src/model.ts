import { action } from "mobx";

import { auditModelClassOnce } from "./audit.js";
import { getModelMetadata } from "./metadata.js";
import { CONTAINER_LINK, HYDRATION_DATA } from "./symbols.js";
import type { ModelPatch } from "./types.js";

export interface ModelContainerLink {
  readonly isApplyingPatches?: boolean;
  recordPatch(patch: ModelPatch): void;
  registerNode(node: Model): void;
  transact<T>(fn: () => T): T;
}

export abstract class Model<TRow = any> {
  readonly uuid: string;
  [HYDRATION_DATA]?: Record<string, unknown>;
  [CONTAINER_LINK]?: ModelContainerLink;

  constructor(props?: Partial<TRow> & Record<string, unknown>) {
    auditModelClassOnce(new.target);

    if (props) {
      this[HYDRATION_DATA] = props as Record<string, unknown>;
    }

    let resolvedId: string | undefined;

    if (typeof props?.uuid === "string" && props.uuid.length > 0) {
      resolvedId = props.uuid;
    } else if (props) {
      const meta = getModelMetadata(new.target);
      for (const col of meta.columns.values()) {
        if (col.primary) {
          const val = props[col.propertyKey] !== undefined ? props[col.propertyKey] : props[col.columnName];
          if (typeof val === "string" && val.length > 0) {
            resolvedId = val;
            break;
          }
        }
      }
    }

    this.uuid = resolvedId ?? crypto.randomUUID();
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
    return this.toRow() as Record<string, unknown>;
  }
}
