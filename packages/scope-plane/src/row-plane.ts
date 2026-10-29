import type { Cell, Row } from "./cells.js";
import type { TableName } from "./schema.js";

/** Match a primary key, or every row whose cell equals `equals`. */
export type RowMatch = { readonly id: string } | { readonly column: string; readonly equals: Cell };

/**
 * Storage port. `watch` may wake on a wider set than the match.
 * The caller re-reads. A `replaceIf` with `expect === undefined` inserts
 * only when the row is absent. Both adapters treat that check as one commit.
 */
export type RowPlane = {
  get(table: TableName, id: string): Promise<Row | undefined>;
  list(table: TableName, column: string, equals: Cell): Promise<readonly { id: string; row: Row }[]>;
  put(table: TableName, id: string, row: Row): Promise<void>;
  remove(table: TableName, id: string): Promise<void>;
  replaceIf(table: TableName, id: string, column: string, expect: Cell | undefined, row: Row): Promise<boolean>;
  insertIfAbsent(table: TableName, id: string, row: Row): Promise<boolean>;
  removeIf(table: TableName, id: string, expect: Row): Promise<boolean>;
  watch(table: TableName, match: RowMatch, onChange: () => void): () => void;
};
