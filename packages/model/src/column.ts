import { observable } from "mobx";

import { SchemaAuditError } from "./errors.js";
import { registerColumnMetadata } from "./metadata.js";
import { CONTAINER_LINK, HYDRATION_DATA } from "./symbols.js";
import type { ColumnCodec, ColumnValue, DrizzleColumnLike, ModelPatch } from "./types.js";

interface Linkable {
  readonly uuid: string;
  [HYDRATION_DATA]?: Record<string, unknown>;
  [CONTAINER_LINK]?: {
    recordPatch(patch: ModelPatch): void;
  };
}

export function column<TCol extends DrizzleColumnLike, TValue = ColumnValue<TCol>>(
  drizzleCol: TCol,
  codec?: ColumnCodec<ColumnValue<TCol>, TValue>,
) {
  return function <This, TActual>(
    target: ClassAccessorDecoratorTarget<This, TActual>,
    context: ClassAccessorDecoratorContext<This, TActual>,
  ): [TActual] extends [TValue]
    ? [TValue] extends [TActual]
      ? ClassAccessorDecoratorResult<This, TActual>
      : {
          readonly __type_error: "Accessor type does not match column type";
          readonly expected: TValue;
          readonly actual: TActual;
        }
    : {
        readonly __type_error: "Accessor type does not match column type";
        readonly expected: TValue;
        readonly actual: TActual;
      } {
    const propertyKey = String(context.name);

    registerColumnMetadata(context, {
      propertyKey,
      columnName: drizzleCol.name,
      column: drizzleCol,
      notNull: drizzleCol.notNull,
      dataType: drizzleCol.dataType,
      columnType: drizzleCol.columnType,
      primary: drizzleCol.primary,
      hasDefault: drizzleCol.hasDefault,
      codec: codec as ColumnCodec<unknown, unknown> | undefined,
    });

    const mobxResult = observable.ref(target, context);
    const getter = mobxResult?.get ?? target.get;
    const setter = mobxResult?.set ?? target.set;
    const initter = mobxResult?.init;

    const result: ClassAccessorDecoratorResult<This, TActual> = {
      get(this: This): TActual {
        return getter.call(this);
      },
      set(this: This, value: TActual): void {
        const oldVal = getter.call(this);
        setter.call(this, value);
        if (!Object.is(oldVal, value)) {
          const self = this as unknown as Linkable;
          const link = self[CONTAINER_LINK];
          if (link) {
            const rawVal = codec ? codec.toDb(value as unknown as TValue) : value;
            link.recordPatch({
              op: "set",
              nodeId: self.uuid,
              field: propertyKey,
              value: rawVal,
            });
          }
        }
      },
      init(this: This, initialValue: TActual): TActual {
        if (initialValue !== undefined) {
          const className = (this as { constructor: { name: string } }).constructor.name;
          throw new SchemaAuditError(
            `Forbidden local default value on DB-driven field "${propertyKey}" on ${className}. Hydrate from a DB row/snapshot instead of declaring a class initializer.`,
          );
        }

        const self = this as unknown as Linkable;
        const props = self[HYDRATION_DATA];
        if (props) {
          const raw = props[propertyKey] !== undefined ? props[propertyKey] : props[drizzleCol.name];
          if (raw !== undefined) {
            const modelVal = codec
              ? (codec.toModel(raw as ColumnValue<TCol>) as unknown as TActual)
              : (raw as unknown as TActual);
            return initter ? initter.call(this, modelVal) : modelVal;
          }
        }

        return initter ? initter.call(this, undefined as unknown as TActual) : (undefined as unknown as TActual);
      },
    };

    return result as any;
  };
}
