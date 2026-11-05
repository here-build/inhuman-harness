import type { InferSelectModel } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import { registerModelClass } from "./metadata.js";
import type { AbstractModelConstructor, AssertModelMatchesTable, ModelOptions } from "./types.js";

type HasSchemaError<T> = true extends {
  [K in keyof T]: T[K] extends { readonly __error: string } ? true : false;
}[keyof T]
  ? true
  : false;

export function model<
  TTable extends SQLiteTable | undefined = undefined,
  const TIgnored extends readonly (TTable extends SQLiteTable ? keyof InferSelectModel<TTable> | string : string)[] =
    readonly [],
>(tag: string, table?: TTable, options?: ModelOptions<TIgnored>) {
  return function <TClass extends AbstractModelConstructor>(
    target: TClass,
    _context: ClassDecoratorContext<TClass>,
  ): [TTable] extends [SQLiteTable]
    ? HasSchemaError<
        AssertModelMatchesTable<TTable, InstanceType<TClass>, Extract<TIgnored[number], keyof InferSelectModel<TTable>>>
      > extends true
      ? {
          readonly __compile_error: "Model class does not match Drizzle table";
          readonly details: AssertModelMatchesTable<
            TTable,
            InstanceType<TClass>,
            Extract<TIgnored[number], keyof InferSelectModel<TTable>>
          >;
        }
      : TClass | void
    : TClass | void {
    registerModelClass(tag, target, table, options);
    return target as any;
  };
}
