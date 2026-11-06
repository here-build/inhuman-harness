import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";

import { SchemaAuditError } from "./errors.js";
import { getModelMetadata } from "./metadata.js";
import type { ClassLike } from "./types.js";

const auditedClasses = new WeakSet<object>();

export function auditModelClassOnce(ctor: ClassLike): void {
  if (auditedClasses.has(ctor)) {
    return;
  }

  const meta = getModelMetadata(ctor);
  if (meta.table != null) {
    const tableConfig = getTableConfig(meta.table);
    const tableColumns = getTableColumns(meta.table);
    const mappedColumns = new Set<string>();

    for (const field of meta.columns.values()) {
      const colTableName = getTableName(field.column.table);
      if (colTableName !== tableConfig.name) {
        throw new SchemaAuditError(
          `${ctor.name}.${field.propertyKey} binds column "${field.columnName}" from table "${colTableName}", expected "${tableConfig.name}"`,
        );
      }
      if (mappedColumns.has(field.columnName)) {
        throw new SchemaAuditError(
          `${ctor.name} maps SQLite column "${tableConfig.name}.${field.columnName}" more than once`,
        );
      }
      mappedColumns.add(field.columnName);
    }

    for (const [colKey, drizzleCol] of Object.entries(tableColumns)) {
      if (
        !mappedColumns.has(drizzleCol.name) &&
        !meta.ignoredColumns.has(drizzleCol.name) &&
        !meta.ignoredColumns.has(colKey)
      ) {
        throw new SchemaAuditError(
          `Model ${ctor.name} (${meta.tag}) is missing @column binding for Drizzle column "${tableConfig.name}.${drizzleCol.name}" (${colKey})`,
        );
      }
    }
  }

  auditedClasses.add(ctor);
}
