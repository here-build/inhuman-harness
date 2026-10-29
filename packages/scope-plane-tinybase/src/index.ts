import {
  createScopePlane,
  type Cell,
  type Row,
  type RowPlane,
  type ScopePlane,
  type TableName,
} from "@inhuman.tools/scope-plane";
import { createStore, type Store } from "tinybase";
import { createFilePersister, type FilePersister } from "tinybase/persisters/persister-file";

/**
 * Hermetic local plane. One process, one plain store.
 * Another machine uses its own adapter over the same scope API.
 */
export type TinybaseScopeOptions = {
  /** JSON file. Absent keeps the store in memory only. */
  readonly file?: string;
};

export type OpenScopePlane = {
  readonly plane: ScopePlane;
  close(): Promise<void>;
};

function copyRow(row: { readonly [cell: string]: unknown }): Row {
  const copy: Record<string, Cell> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") copy[key] = value;
  }
  return copy;
}

export function createTinybaseRowPlane(store: Store): RowPlane {
  function write(table: TableName, id: string, row: Row): void {
    store.delRow(table, id);
    store.setRow(table, id, { ...row });
  }

  return {
    async get(table, id) {
      if (!store.hasRow(table, id)) return undefined;
      return copyRow(store.getRow(table, id));
    },
    async list(table, column, equals) {
      const found: { id: string; row: Row }[] = [];
      store.forEachRow(table, (id) => {
        const row = store.getRow(table, id);
        if (row[column] === equals) found.push({ id, row: copyRow(row) });
      });
      return found;
    },
    async put(table, id, row) {
      write(table, id, row);
    },
    async remove(table, id) {
      store.delRow(table, id);
    },
    async replaceIf(table, id, column, expected, row) {
      return store.transaction(() => {
        const exists = store.hasRow(table, id);
        if (expected === undefined) {
          if (exists) return false;
          write(table, id, row);
          return true;
        }
        if (!exists || store.getCell(table, id, column) !== expected) return false;
        write(table, id, row);
        return true;
      });
    },
    async insertIfAbsent(table, id, row) {
      return store.transaction(() => {
        if (store.hasRow(table, id)) return false;
        store.setRow(table, id, { ...row });
        return true;
      });
    },
    async removeIf(table, id, expected) {
      return store.transaction(() => {
        if (!store.hasRow(table, id)) return false;
        const row = store.getRow(table, id);
        for (const [key, value] of Object.entries(expected)) {
          if (row[key] !== value) return false;
        }
        store.delRow(table, id);
        return true;
      });
    },
    watch(table, _match, onChange) {
      const listenerId = store.addTableListener(table, () => {
        onChange();
      });
      return () => {
        store.delListener(listenerId);
      };
    },
  };
}

export async function createTinybaseScopePlane(options?: TinybaseScopeOptions): Promise<OpenScopePlane> {
  const store = createStore();
  let persister: FilePersister | undefined;
  if (options?.file != null) {
    persister = createFilePersister(store, options.file);
    await persister.load();
    await persister.startAutoSave();
  }
  return {
    plane: createScopePlane(createTinybaseRowPlane(store)),
    async close() {
      await persister?.save();
      await persister?.destroy();
    },
  };
}
